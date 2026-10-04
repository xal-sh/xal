use std::collections::BTreeMap;

use xal_services::workflows::{Plan, TrackedTask};

use super::*;
use crate::interactions::Interactions;
use crate::permissions::Permissions;
use crate::workflows::{PlanDecision, Update};

#[derive(Default)]
pub(super) struct Workflows {
    pub plan: Option<Plan>,
    pub tasks: Vec<TrackedTask>,
    pub modes: BTreeMap<String, (Permissions, String)>,
    pub mode_before_plan: Option<String>,
    pub dismissed: bool,
    pub restart: bool,
}

impl Agent<'_> {
    pub fn configure_modes(&mut self, modes: Vec<(Permissions, String)>) {
        self.workflows.modes = modes
            .into_iter()
            .map(|(policy, instructions)| (policy.mode.clone(), (policy, instructions)))
            .collect();
    }

    pub fn plan(&self) -> Option<&Plan> {
        self.workflows.plan.as_ref()
    }
    pub fn tasks(&self) -> &[TrackedTask] {
        &self.workflows.tasks
    }

    pub fn set_mode(&mut self, mode: &str) -> Result<()> {
        if mode == self.options.mode {
            return Ok(());
        }
        let (policy, instructions) = self
            .workflows
            .modes
            .get(mode)
            .cloned()
            .ok_or_else(|| failure(format!("mode {mode} is unavailable")))?;
        self.sink
            .events(&[AgentEvent::ModeChanged { mode: mode.into() }])?;
        self.apply_mode(mode, policy, instructions)
    }

    fn apply_mode(&mut self, mode: &str, policy: Permissions, instructions: String) -> Result<()> {
        if policy.read_only && !self.session.read_only {
            self.workflows.mode_before_plan = Some(self.options.mode.clone());
        }
        if !policy.read_only {
            self.workflows.mode_before_plan = None;
        }
        self.session.read_only = policy.read_only;
        self.host.session_permissions(&self.session.id, policy)?;
        self.options.mode = mode.into();
        self.options.instructions = instructions;
        self.loops = loops::ToolLoops::default();
        Ok(())
    }

    pub(super) fn interactions(&mut self, interactions: &Interactions) -> Result<()> {
        for event in interactions.drain()? {
            self.sink.emit(event)?;
        }
        for (update, reply) in interactions.updates()? {
            if reply.is_closed() {
                continue;
            }
            let result = self.update_workflow(update);
            let failed = result.clone();
            if reply.send(result).is_err() {
                return Err(failure("workflow receiver closed during transition"));
            }
            failed?;
        }
        Ok(())
    }

    fn update_workflow(&mut self, update: Update) -> Result<()> {
        match update {
            Update::Tasks { tasks, explanation } => {
                self.sink.events(&[AgentEvent::TaskListUpdated {
                    tasks: tasks.clone(),
                    explanation,
                }])?;
                self.workflows.tasks = tasks;
            }
            Update::Plan { plan, decision } => {
                match decision {
                    PlanDecision::Draft | PlanDecision::Revision | PlanDecision::Dismissed => {
                        self.sink
                            .events(&[AgentEvent::PlanUpdated { plan: plan.clone() }])?;
                        self.workflows.dismissed = matches!(decision, PlanDecision::Dismissed);
                    }
                    PlanDecision::Build { restart } => {
                        let mode = self
                            .workflows
                            .mode_before_plan
                            .as_deref()
                            .filter(|mode| {
                                self.workflows
                                    .modes
                                    .get(*mode)
                                    .is_some_and(|(policy, _)| !policy.read_only)
                            })
                            .unwrap_or("normal")
                            .to_owned();
                        let (policy, instructions) = self
                            .workflows
                            .modes
                            .get(&mode)
                            .cloned()
                            .ok_or_else(|| failure(format!("mode {mode} is unavailable")))?;
                        self.sink.events(&[
                            AgentEvent::PlanUpdated { plan: plan.clone() },
                            AgentEvent::ModeChanged { mode: mode.clone() },
                        ])?;
                        self.apply_mode(&mode, policy, instructions)?;
                        self.workflows.restart = restart;
                    }
                }
                self.workflows.plan = Some(plan);
            }
        }
        Ok(())
    }

    pub(super) async fn await_interaction<T>(
        &mut self,
        interactions: &Interactions,
        operation: impl std::future::Future<Output = Result<T>>,
    ) -> Result<T> {
        tokio::pin!(operation);
        loop {
            tokio::select! {
                result = &mut operation => { self.interactions(interactions)?; return result; }
                () = interactions.changed.notified() => self.interactions(interactions)?,
                () = self.control.changed.notified() => stream::queue_changed(&self.control, &mut self.sink)?,
            }
        }
    }

    pub(super) async fn approval(
        &mut self,
        prepared: &mut PreparedTool,
        id: &str,
        title: &str,
        active: &Session,
    ) -> Result<()> {
        match self.host.authorize_tool(prepared, active).await {
            Err(Error::ApprovalRequired(_)) => {}
            result => return result,
        }
        let request = PermissionRequest {
            tool: prepared.name.clone(),
            args: prepared.args.clone(),
            read_only: prepared.effects == Effects::Read,
            subject: prepared.subject.clone(),
        };
        let event = AgentEvent::ApprovalRequested {
            pattern: Some(Permissions::rule(&request, &active.cwd)?),
            call_id: id.into(),
            tool: prepared.name.clone(),
            title: title.into(),
            read_only: prepared.effects == Effects::Read,
        };
        if self.defer_interactions {
            self.sink.emit(event)?;
            return Err(Error::NeedsInput);
        }
        if self.session.kind == SessionKind::Task {
            return Err(Error::Denied(
                "Task agents cannot request user approval; this action was not run.".into(),
            ));
        }
        if self.session.kind != SessionKind::Interactive {
            self.sink.emit(event)?;
            return Err(Error::ApprovalRequired(
                "This action needed approval but the session is headless, so it was not run."
                    .into(),
            ));
        }
        self.state(AgentState::AwaitingApproval)?;
        let interactions = self.host.interactions.get(&self.session.id)?;
        let approved = self
            .await_interaction(
                &interactions,
                interactions.approval(event, &active.cancellation),
            )
            .await?;
        self.state(AgentState::RunningTool)?;
        match approved {
            crate::interactions::Approval::Denied => {
                return Err(Error::Denied(
                    "The user declined this action. Adjust rather than retrying.".into(),
                ));
            }
            crate::interactions::Approval::Once => {}
            crate::interactions::Approval::Session { ref pattern }
            | crate::interactions::Approval::Always { ref pattern } => {
                let mut policy = self
                    .host
                    .permission_for(&self.session.id)?
                    .ok_or_else(|| failure("permission storage unavailable"))?;
                policy.remember(
                    &request,
                    &active.cwd,
                    pattern,
                    matches!(approved, crate::interactions::Approval::Always { .. }),
                )?;
                self.host.session_permissions(&self.session.id, policy)?;
            }
        }
        prepared.approved = true;
        Ok(())
    }
}

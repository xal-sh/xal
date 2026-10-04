use super::*;

impl Agent<'_> {
    pub(super) fn parent_questions(&mut self) -> Result<bool> {
        let Some(service) = &self.session.tasks else {
            return Ok(false);
        };
        let questions = service.questions(&self.session.id)?;
        if questions.is_empty() {
            return Ok(false);
        }
        self.sink.events(&[AgentEvent::AgentQuestions {
            questions: questions.clone(),
        }])?;
        service.acknowledge_questions(&self.session.id, &questions)?;
        Ok(true)
    }

    pub(super) fn background_results(&mut self) -> Result<bool> {
        let jobs = self.session.jobs.clone();
        let deliveries = jobs.deliveries()?;
        if deliveries.is_empty() {
            return Ok(false);
        }
        let results = deliveries
            .iter()
            .map(|(_, result)| result.clone())
            .collect::<Vec<_>>();
        let result = (|| {
            let item = Item::user(format!(
                "<system-notice>\n\nBackground work has finished. Resume your work using its result.\n\n{}\n\n{}\n\n</system-notice>",
                if jobs.running()? {
                    "Other background work is still running."
                } else {
                    "No background work remains running."
                },
                results
                    .iter()
                    .map(crate::jobs::BackgroundResult::message)
                    .collect::<Vec<_>>()
                    .join("\n\n")
            ));
            let item = redaction::item(self.host, self.sink.redactor, item, &self.session)?;
            self.sink.paired(
                AgentEvent::BackgroundResults { results },
                serde_json::to_value(&item).map_err(failure)?,
            )?;
            Ok(item)
        })();
        for (job, _) in deliveries {
            jobs.delivered(&job, result.is_ok())?;
        }
        self.history.push(result?);
        self.background_warned = false;
        self.loops = loops::ToolLoops::default();
        if let Some(contract) = &mut self.contract {
            contract.reset();
        }
        Ok(true)
    }

    pub(super) async fn background_boundary(&mut self) -> Result<bool> {
        let jobs = self.session.jobs.clone();
        if self
            .session
            .tasks
            .as_ref()
            .map(|service| service.unanswered(&self.session.id))
            .transpose()?
            .unwrap_or(false)
        {
            return Ok(true);
        }
        let interactions = self.host.interactions.get(&self.session.id)?;
        loop {
            self.control.boundary()?;
            let changed = jobs.activity.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            self.interactions(&interactions)?;
            if self.parent_questions()?
                || self.background_results()?
                || !self.control.pending()?.is_empty()
            {
                return Ok(true);
            }
            if !jobs.unsettled()? {
                return Ok(false);
            }
            if !self.background_warned {
                self.background_warned = true;
                self.push(Item::user("Your response is not final while managed background work is running. Collect results with job_output, or stop long-lived servers/watchers with job_kill. Account for every result before your final report.".into()))?;
                return Ok(true);
            }
            self.state(AgentState::WaitingBackground)?;
            tokio::select! {
                () = &mut changed => {},
                () = interactions.changed.notified() => {},
                () = self.control.changed.notified() => return Ok(true),
                () = self.session.cancellation.cancelled() => return Err(Error::Cancelled),
            }
        }
    }
}

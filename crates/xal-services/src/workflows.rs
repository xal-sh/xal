use std::io;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::storage::invalid;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    Pending,
    InProgress,
    Completed,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TrackedTask {
    pub step: String,
    pub status: TaskStatus,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlanStatus {
    Draft,
    Approved,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Plan {
    pub path: PathBuf,
    pub markdown: String,
    pub status: PlanStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub feedback: Option<String>,
}

impl Plan {
    pub fn parse(value: &Value) -> io::Result<Self> {
        let mut plan: Self =
            serde_json::from_value(value.clone()).map_err(|error| invalid(error.to_string()))?;
        plan.markdown = plan.markdown.trim().into();
        if !plan.path.is_absolute()
            || plan.markdown.is_empty()
            || plan.markdown.encode_utf16().count() > 50_000
            || plan.feedback.as_ref().is_some_and(|s| s.trim().is_empty())
        {
            return Err(invalid("invalid session plan"));
        }
        Ok(plan)
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SuspensionCause {
    Interruption,
    TurnFailure,
    EvaluatorFailure,
    NoProgress,
    HistoryMovement,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "status",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum GoalStatus {
    Active,
    Suspended {
        suspended_at: u64,
        suspension_cause: SuspensionCause,
    },
    Achieved {
        ended_at: u64,
    },
    Impossible {
        ended_at: u64,
    },
    Cleared {
        ended_at: u64,
    },
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GoalUsage {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total_input_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_read_input_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_write_input_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_tokens: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Goal {
    pub id: String,
    pub condition: String,
    pub started_at: u64,
    pub evaluated_turns: u64,
    pub usage: GoalUsage,
    pub evaluator_model: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_reason: Option<String>,
    pub consecutive_no_tool_turns: u64,
    #[serde(flatten)]
    pub status: GoalStatus,
}

impl Goal {
    pub fn condition(condition: &str) -> io::Result<()> {
        if condition.trim().is_empty() || condition.chars().count() > 4_000 {
            return Err(invalid("goal condition must contain 1–4,000 characters"));
        }
        Ok(())
    }

    pub fn parse(value: &Value) -> io::Result<Self> {
        let goal: Self =
            serde_json::from_value(value.clone()).map_err(|error| invalid(error.to_string()))?;
        Self::condition(&goal.condition)?;
        let mut keys = vec![
            "status",
            "id",
            "condition",
            "startedAt",
            "evaluatedTurns",
            "usage",
            "evaluatorModel",
            "lastReason",
            "consecutiveNoToolTurns",
        ];
        let ended = match goal.status {
            GoalStatus::Active => None,
            GoalStatus::Suspended { suspended_at, .. } => {
                keys.extend(["suspendedAt", "suspensionCause"]);
                Some(suspended_at)
            }
            GoalStatus::Achieved { ended_at }
            | GoalStatus::Impossible { ended_at }
            | GoalStatus::Cleared { ended_at } => {
                keys.push("endedAt");
                Some(ended_at)
            }
        };
        if value
            .as_object()
            .is_none_or(|v| v.keys().any(|k| !keys.contains(&k.as_str())))
            || goal.id.trim().is_empty()
            || goal.evaluator_model.trim().is_empty()
            || goal.consecutive_no_tool_turns > goal.evaluated_turns
            || goal
                .last_reason
                .as_ref()
                .is_some_and(|s| s.trim().is_empty())
            || (matches!(
                goal.status,
                GoalStatus::Achieved { .. } | GoalStatus::Impossible { .. }
            ) && goal.last_reason.is_none())
            || ended.is_some_and(|n| n < goal.started_at)
            || [
                Some(goal.started_at),
                Some(goal.evaluated_turns),
                ended,
                goal.usage.total_input_tokens,
                goal.usage.cache_read_input_tokens,
                goal.usage.cache_write_input_tokens,
                goal.usage.output_tokens,
            ]
            .into_iter()
            .flatten()
            .any(|n| n > 9_007_199_254_740_991)
        {
            return Err(invalid("invalid goal snapshot"));
        }
        Ok(goal)
    }

    pub fn active(&self) -> bool {
        self.status == GoalStatus::Active
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VerdictKind {
    NotYetMet,
    Met,
    Impossible,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Verdict {
    pub verdict: VerdictKind,
    pub reason: String,
}

impl Verdict {
    pub fn parse(text: &str) -> io::Result<Self> {
        let verdict: Self =
            serde_json::from_str(text).map_err(|error| invalid(error.to_string()))?;
        if verdict.reason.trim().is_empty() {
            return Err(invalid("goal evaluator returned an empty reason"));
        }
        Ok(verdict)
    }
}

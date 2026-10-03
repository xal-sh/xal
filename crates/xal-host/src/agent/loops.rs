use std::collections::VecDeque;

use crate::JsonObject;

#[derive(Default)]
pub(super) struct ToolLoops {
    results: VecDeque<(String, String)>,
    steered: VecDeque<String>,
}

pub(super) enum Action {
    Allow,
    Steer,
    Stop,
}

impl ToolLoops {
    pub fn inspect(&mut self, name: &str, args: &JsonObject) -> Action {
        let signature = format!("{name}:{}", serde_json::Value::Object(args.clone()));
        if self.steered.contains(&signature) {
            return Action::Stop;
        }
        let mut matching = self
            .results
            .iter()
            .rev()
            .filter(|(key, _)| key == &signature);
        let (Some((_, latest)), Some((_, previous))) = (matching.next(), matching.next()) else {
            return Action::Allow;
        };
        if latest != previous {
            return Action::Allow;
        }
        if self.steered.len() == 12 {
            self.steered.pop_front();
        }
        self.steered.push_back(signature);
        Action::Steer
    }

    pub fn record(&mut self, name: &str, args: &JsonObject, output: &str) {
        if self.results.len() == 12 {
            self.results.pop_front();
        }
        self.results.push_back((
            format!("{name}:{}", serde_json::Value::Object(args.clone())),
            output.into(),
        ));
    }
}

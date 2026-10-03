use std::collections::{HashMap, VecDeque};

pub struct Redactor {
    matcher: SecretMatcher,
    protected: Vec<String>,
}

impl Redactor {
    pub fn new(mut values: Vec<String>) -> Result<Self, &'static str> {
        values.retain(|value| !value.is_empty());
        let marker = ["[REDACTED]", "<hidden>", "***", "•••", "_"]
            .into_iter()
            .map(str::to_owned)
            .chain(
                (0xe000..=0xf8ff)
                    .filter_map(char::from_u32)
                    .map(|value| value.to_string()),
            )
            .find(|candidate| {
                values
                    .iter()
                    .all(|value| !candidate.contains(value) && !value.contains(candidate))
            })
            .ok_or("secret redaction marker resolution failed")?;
        Ok(Self {
            matcher: SecretMatcher::new(
                values
                    .iter()
                    .map(|value| value.encode_utf16().collect())
                    .collect(),
                marker.encode_utf16().collect(),
            )?,
            protected: values.into_iter().chain(Some(marker)).collect(),
        })
    }

    pub fn stream(&self) -> RedactedStream<'_> {
        RedactedStream {
            redactor: self,
            pending: String::new(),
        }
    }

    pub fn redact_json(&self, value: &serde_json::Value) -> serde_json::Value {
        match value {
            serde_json::Value::String(value) => serde_json::Value::String(self.redact(value)),
            serde_json::Value::Array(values) => serde_json::Value::Array(
                values.iter().map(|value| self.redact_json(value)).collect(),
            ),
            serde_json::Value::Object(values) => serde_json::Value::Object(
                values
                    .iter()
                    .map(|(key, value)| (self.redact(key), self.redact_json(value)))
                    .collect(),
            ),
            value => value.clone(),
        }
    }

    pub fn redact(&self, input: &str) -> String {
        String::from_utf16(
            &self
                .matcher
                .redact(&input.encode_utf16().collect::<Vec<_>>()),
        )
        .expect("redaction of valid Unicode must remain valid Unicode")
    }
}

pub struct RedactedStream<'a> {
    redactor: &'a Redactor,
    pending: String,
}

impl RedactedStream<'_> {
    pub fn write(&mut self, text: &str) -> String {
        self.pending.push_str(text);
        let mut boundary = self.pending.len();
        for value in &self.redactor.protected {
            for (length, _) in value.char_indices().skip(1) {
                if self.pending.ends_with(&value[..length]) {
                    boundary = boundary.min(self.pending.len() - length);
                }
            }
        }
        loop {
            let previous = boundary;
            for value in &self.redactor.protected {
                for (start, _) in self
                    .pending
                    .char_indices()
                    .take_while(|(start, _)| *start < boundary)
                {
                    if self.pending[start..].starts_with(value) && start + value.len() > boundary {
                        boundary = start;
                        break;
                    }
                }
            }
            if previous == boundary {
                break;
            }
        }
        let tail = self.pending.split_off(boundary);
        let output = self.redactor.redact(&self.pending);
        self.pending = tail;
        output
    }

    pub fn end(&mut self) -> String {
        self.redactor.redact(&std::mem::take(&mut self.pending))
    }
}

#[derive(Default)]
struct Node {
    transitions: HashMap<u16, usize>,
    failure: usize,
    marker_length: usize,
    secret_length: usize,
    secret_output: usize,
}

#[derive(Clone, Copy, Default)]
struct Candidate {
    marker_length: usize,
    secret_length: usize,
}

pub struct SecretMatcher {
    marker: Vec<u16>,
    nodes: Vec<Node>,
}

impl SecretMatcher {
    pub fn new(values: Vec<Vec<u16>>, marker: Vec<u16>) -> Result<Self, &'static str> {
        if marker.is_empty() {
            return Err("redaction marker must not be empty");
        }
        if values.iter().any(Vec::is_empty) {
            return Err("secret values must not be empty");
        }
        if values
            .iter()
            .any(|value| contains(value, &marker) || contains(&marker, value))
        {
            return Err("redaction marker must not overlap secret values");
        }

        let mut nodes = vec![Node::default()];
        for value in &values {
            let state = insert(&mut nodes, value);
            nodes[state].secret_length = nodes[state].secret_length.max(value.len());
        }
        let marker_state = insert(&mut nodes, &marker);
        nodes[marker_state].marker_length = marker.len();
        build_failure_links(&mut nodes);

        Ok(Self { marker, nodes })
    }

    pub fn redact(&self, input: &[u16]) -> Vec<u16> {
        let mut candidates = vec![Candidate::default(); input.len()];
        let mut state = 0;

        for (end, unit) in input.iter().copied().enumerate() {
            state = transition(&self.nodes, state, unit);
            let node = &self.nodes[state];
            if node.marker_length > 0 {
                let start = end + 1 - node.marker_length;
                candidates[start].marker_length = node.marker_length;
            }
            let mut output_state = state;
            loop {
                let secret_length = self.nodes[output_state].secret_length;
                if secret_length > 0 {
                    let start = end + 1 - secret_length;
                    candidates[start].secret_length =
                        candidates[start].secret_length.max(secret_length);
                }
                output_state = self.nodes[output_state].secret_output;
                if output_state == 0 {
                    break;
                }
            }
        }

        let mut output = Vec::with_capacity(input.len());
        let mut cursor = 0;
        while cursor < input.len() {
            let candidate = candidates[cursor];
            if candidate.marker_length > 0 {
                output.extend_from_slice(&self.marker);
                cursor += candidate.marker_length;
                continue;
            }
            if candidate.secret_length > 0 {
                output.extend_from_slice(&self.marker);
                cursor += candidate.secret_length;
                continue;
            }
            output.push(input[cursor]);
            cursor += 1;
        }
        output
    }
}

fn contains(value: &[u16], candidate: &[u16]) -> bool {
    value
        .windows(candidate.len())
        .any(|window| window == candidate)
}

fn insert(nodes: &mut Vec<Node>, pattern: &[u16]) -> usize {
    let mut state = 0;
    for unit in pattern {
        if let Some(next) = nodes[state].transitions.get(unit).copied() {
            state = next;
            continue;
        }
        let next = nodes.len();
        nodes.push(Node::default());
        nodes[state].transitions.insert(*unit, next);
        state = next;
    }
    state
}

fn build_failure_links(nodes: &mut [Node]) {
    let mut queue = VecDeque::new();
    let root_children = nodes[0].transitions.values().copied().collect::<Vec<_>>();
    for child in root_children {
        queue.push_back(child);
    }

    while let Some(state) = queue.pop_front() {
        let children = nodes[state]
            .transitions
            .iter()
            .map(|(unit, child)| (*unit, *child))
            .collect::<Vec<_>>();
        for (unit, child) in children {
            let failure = transition(nodes, nodes[state].failure, unit);
            nodes[child].failure = failure;
            nodes[child].marker_length =
                nodes[child].marker_length.max(nodes[failure].marker_length);
            nodes[child].secret_output = if nodes[failure].secret_length > 0 {
                failure
            } else {
                nodes[failure].secret_output
            };
            queue.push_back(child);
        }
    }
}

fn transition(nodes: &[Node], mut state: usize, unit: u16) -> usize {
    loop {
        if let Some(next) = nodes[state].transitions.get(&unit) {
            return *next;
        }
        if state == 0 {
            return 0;
        }
        state = nodes[state].failure;
    }
}

#[cfg(test)]
mod tests {
    use super::{Redactor, SecretMatcher};

    #[test]
    fn streams_hold_secret_prefixes_and_redact_json_keys_and_values() {
        let redactor = Redactor::new(vec![
            "token".into(),
            "token-value".into(),
            "🔐secret".into(),
        ])
        .unwrap();
        for text in [
            "token-value then token",
            "🔐secret [REDACTED]",
            "token-valu",
            "normal text",
        ] {
            for (boundary, _) in text.char_indices().chain(Some((text.len(), '\0'))) {
                let mut stream = redactor.stream();
                let mut output = stream.write(&text[..boundary]);
                output.push_str(&stream.write(&text[boundary..]));
                output.push_str(&stream.end());
                assert_eq!(output, redactor.redact(text));
            }
        }
        let mut stream = redactor.stream();
        assert_eq!(stream.write("prefix to"), "prefix ");
        assert_eq!(stream.write("ken-val"), "");
        assert_eq!(stream.write("ue."), "[REDACTED].");
        assert_eq!(stream.end(), "");
        assert_eq!(
            redactor.redact_json(&serde_json::json!({"token":["🔐secret",null,1]})),
            serde_json::json!({"[REDACTED]":["[REDACTED]",null,1]})
        );
    }

    #[test]
    fn native_strings_select_safe_markers_and_preserve_unicode() {
        let redactor =
            Redactor::new(vec!["[REDACTED]".into(), "🔐token".into(), "".into()]).unwrap();
        assert_eq!(
            redactor.redact("🔐token [REDACTED] <hidden>"),
            "<hidden> <hidden> <hidden>"
        );
        let redactor = Redactor::new(vec![]).unwrap();
        assert_eq!(redactor.redact("unchanged 🔐"), "unchanged 🔐");
    }

    fn units(value: &str) -> Vec<u16> {
        value.encode_utf16().collect()
    }

    #[test]
    fn prefers_earliest_then_longest_overlap() {
        let matcher = SecretMatcher::new(
            vec![units("token"), units("token-value"), units("value")],
            units("[REDACTED]"),
        )
        .expect("matcher should be valid");

        assert_eq!(
            matcher.redact(&units("token-value then token")),
            units("[REDACTED] then [REDACTED]")
        );
    }

    #[test]
    fn preserves_markers_and_rejects_collisions() {
        let marker = units("[REDACTED]");
        let matcher = SecretMatcher::new(vec![units("secret-value")], marker.clone())
            .expect("matcher should be valid");

        assert_eq!(
            matcher.redact(&units("secret-value and [REDACTED]")),
            units("[REDACTED] and [REDACTED]")
        );
        assert_eq!(matcher.redact(&marker), marker);
        assert!(SecretMatcher::new(vec![units("secret-[REDACTED]-value")], marker).is_err());
        assert!(SecretMatcher::new(vec![units("abcd")], units("a")).is_err());
    }

    #[test]
    fn matches_unicode_and_lone_surrogate_code_units_exactly() {
        let marker = units("<hidden>");
        let secret = vec![0x732b, 0xd800, 0x2603];
        let matcher = SecretMatcher::new(vec![secret.clone(), units("🔐")], marker.clone())
            .expect("matcher should be valid");
        let mut input = vec![0x524d, 0x0020];
        input.extend_from_slice(&secret);
        input.extend_from_slice(&[0x0020, 0xd801, 0x2603, 0x0020]);
        input.extend_from_slice(&units("🔐"));
        let mut expected = vec![0x524d, 0x0020];
        expected.extend_from_slice(&marker);
        expected.extend_from_slice(&[0x0020, 0xd801, 0x2603, 0x0020]);
        expected.extend_from_slice(&marker);

        assert_eq!(matcher.redact(&input), expected);
    }

    #[test]
    fn rejects_empty_marker_and_values() {
        assert!(SecretMatcher::new(vec![units("secret")], Vec::new()).is_err());
        assert!(SecretMatcher::new(vec![Vec::new()], units("[REDACTED]")).is_err());
    }
}

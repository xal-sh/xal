struct HereDoc {
    delimiter: String,
    expand: bool,
    strip_tabs: bool,
}

struct Parser {
    chars: Vec<char>,
    index: usize,
}

pub(super) fn segments(command: &str) -> Option<Vec<String>> {
    Parser {
        chars: command.chars().collect(),
        index: 0,
    }
    .compound(None, 0)
}

fn control_body(mut text: &str) -> &str {
    text = text.trim();
    loop {
        if let Some(rest) = text.strip_prefix('!') {
            text = rest.trim_start();
            continue;
        }
        let prefix = ["if", "then", "elif", "else", "while", "until", "do"]
            .into_iter()
            .find(|word| {
                text.strip_prefix(word).is_some_and(|rest| {
                    rest.chars()
                        .next()
                        .is_none_or(|ch| !ch.is_alphanumeric() && ch != '_')
                })
            });
        let Some(prefix) = prefix else {
            return text;
        };
        text = text[prefix.len()..].trim_start();
    }
}

fn starts_word(text: &str, word: &str) -> bool {
    text.strip_prefix(word).is_some_and(|rest| {
        rest.chars()
            .next()
            .is_none_or(|ch| !ch.is_alphanumeric() && ch != '_')
    })
}

fn case_pattern(text: &str) -> bool {
    starts_word(text, "case") && text.split_whitespace().any(|word| word == "in")
}

fn push(current: &mut String, segments: &mut Vec<String>, case_depth: &mut usize) -> Option<()> {
    let body = control_body(current);
    if starts_word(body, "coproc") {
        return None;
    }
    if case_pattern(body) {
        *case_depth += 1;
    } else if starts_word(body, "esac") {
        *case_depth = case_depth.saturating_sub(1);
    }
    if !body.is_empty() {
        segments.push(body.into());
    }
    current.clear();
    Some(())
}

impl Parser {
    fn at(&self, offset: usize) -> Option<char> {
        self.chars.get(self.index + offset).copied()
    }

    fn expansion(&self) -> bool {
        self.at(0) == Some('`')
            || (self.at(0) == Some('$')
                && (self.at(1) == Some('(')
                    || (self.at(1) == Some('{')
                        && self.at(2).is_some_and(|ch| ch.is_whitespace() || ch == '|'))))
    }

    fn expand(&mut self, depth: usize) -> Option<Vec<String>> {
        if self.at(0) == Some('`') {
            self.index += 1;
            return self.compound(Some('`'), depth + 1);
        }
        if self.at(1) == Some('{') {
            self.index += 2;
            return self.compound(Some('}'), depth + 1);
        }
        if self.at(2) == Some('(') {
            self.index += 3;
            return self.arithmetic(depth + 1);
        }
        self.index += 2;
        self.compound(Some(')'), depth + 1)
    }

    fn single(&mut self) -> Option<String> {
        let start = self.index;
        self.index += 1;
        while let Some(ch) = self.at(0) {
            self.index += 1;
            if ch == '\'' {
                return Some(self.chars[start..self.index].iter().collect());
            }
        }
        None
    }

    fn double(&mut self, depth: usize) -> Option<(String, Vec<String>)> {
        let mut text = String::from("\"");
        let mut segments = Vec::new();
        self.index += 1;
        while let Some(ch) = self.at(0) {
            if ch == '\\' {
                let next = self.at(1)?;
                if next != '\n' {
                    text.push(ch);
                    text.push(next);
                }
                self.index += 2;
                continue;
            }
            if ch == '"' {
                self.index += 1;
                text.push(ch);
                return Some((text, segments));
            }
            if self.expansion() {
                segments.extend(self.expand(depth)?);
                text.push_str("$()");
                continue;
            }
            text.push(ch);
            self.index += 1;
        }
        None
    }

    fn arithmetic(&mut self, nesting: usize) -> Option<Vec<String>> {
        if nesting > 32 {
            return None;
        }
        let mut depth = 1usize;
        let mut segments = Vec::new();
        while let Some(ch) = self.at(0) {
            if ch == '\\' {
                self.index += 2;
                continue;
            }
            if ch == '\'' {
                self.single()?;
                continue;
            }
            if ch == '"' {
                segments.extend(self.double(nesting)?.1);
                continue;
            }
            if self.expansion() {
                segments.extend(self.expand(nesting)?);
                continue;
            }
            if ch == '(' {
                depth += 1;
            }
            if ch == ')' {
                if depth == 1 && self.at(1) == Some(')') {
                    self.index += 2;
                    return Some(segments);
                }
                depth = depth.checked_sub(1)?;
                if depth == 0 {
                    return None;
                }
            }
            self.index += 1;
        }
        None
    }

    fn here_doc(&mut self) -> Option<(String, HereDoc)> {
        let start = self.index;
        self.index += 2;
        let strip_tabs = self.at(0) == Some('-');
        if strip_tabs {
            self.index += 1;
        }
        while self.at(0).is_some_and(char::is_whitespace) {
            self.index += 1;
        }
        let quote = self.at(0).filter(|ch| *ch == '\'' || *ch == '"');
        if quote.is_some() {
            self.index += 1;
        }
        let mut delimiter = String::new();
        while let Some(ch) = self.at(0) {
            if Some(ch) == quote {
                self.index += 1;
                break;
            }
            if quote.is_none() && (ch.is_whitespace() || ";&|<>".contains(ch)) {
                break;
            }
            delimiter.push(ch);
            self.index += 1;
        }
        if delimiter.is_empty() {
            return None;
        }
        Some((
            self.chars[start..self.index].iter().collect(),
            HereDoc {
                delimiter,
                expand: quote.is_none(),
                strip_tabs,
            },
        ))
    }

    fn here_bodies(
        &mut self,
        docs: Vec<HereDoc>,
        execute: bool,
        depth: usize,
    ) -> Option<Vec<String>> {
        let mut segments = Vec::new();
        for doc in docs {
            let mut body = String::new();
            loop {
                let start = self.index;
                while self.at(0).is_some_and(|ch| ch != '\n') {
                    self.index += 1;
                }
                let line: String = self.chars[start..self.index].iter().collect();
                let ended = self.at(0).is_none();
                if !ended {
                    self.index += 1;
                }
                let compared = if doc.strip_tabs {
                    line.trim_start_matches('\t')
                } else {
                    &line
                };
                if compared == doc.delimiter {
                    break;
                }
                body.push_str(&line);
                body.push('\n');
                if ended {
                    return None;
                }
            }
            let mut parser = Self {
                chars: body.chars().collect(),
                index: 0,
            };
            if execute && !body.trim().is_empty() {
                segments.extend(parser.compound(None, depth + 1)?);
            } else if doc.expand {
                while let Some(ch) = parser.at(0) {
                    if ch == '\\' {
                        parser.index += 2;
                        continue;
                    }
                    if parser.expansion() {
                        segments.extend(parser.expand(depth)?);
                        continue;
                    }
                    parser.index += 1;
                }
            }
        }
        Some(segments)
    }

    fn compound(&mut self, end: Option<char>, depth: usize) -> Option<Vec<String>> {
        if depth > 32 {
            return None;
        }
        let mut segments = Vec::new();
        let mut current = String::new();
        let mut docs = Vec::new();
        let mut case_depth = 0;
        while let Some(ch) = self.at(0) {
            if Some(ch) == end {
                let body = control_body(&current);
                let pattern = case_pattern(body) || (case_depth > 0 && !starts_word(body, "esac"));
                if end == Some(')') && pattern {
                    push(&mut current, &mut segments, &mut case_depth)?;
                    self.index += 1;
                    continue;
                }
                if !docs.is_empty() {
                    return None;
                }
                push(&mut current, &mut segments, &mut case_depth)?;
                if case_depth > 0 {
                    return None;
                }
                self.index += 1;
                return Some(segments);
            }
            if ch == '\\' {
                let next = self.at(1)?;
                if next != '\n' {
                    current.push(ch);
                    current.push(next);
                }
                self.index += 2;
                continue;
            }
            if ch == '<' && self.at(1) == Some('<') {
                let (text, doc) = self.here_doc()?;
                current.push_str(&text);
                docs.push(doc);
                continue;
            }
            if ch == '\'' {
                current.push_str(&self.single()?);
                continue;
            }
            if ch == '"' {
                let (text, nested) = self.double(depth)?;
                current.push_str(&text);
                segments.extend(nested);
                continue;
            }
            if self.expansion() {
                segments.extend(self.expand(depth)?);
                current.push_str("$()");
                continue;
            }
            if ch == '(' {
                push(&mut current, &mut segments, &mut case_depth)?;
                self.index += 1;
                segments.extend(self.compound(Some(')'), depth + 1)?);
                continue;
            }
            let boundary =
                |ch: Option<char>| ch.is_none_or(|ch| ch.is_whitespace() || ";&|()".contains(ch));
            if ch == ')'
                || ((ch == '{' || ch == '}')
                    && boundary(
                        self.index
                            .checked_sub(1)
                            .and_then(|index| self.chars.get(index).copied()),
                    )
                    && boundary(self.at(1)))
            {
                push(&mut current, &mut segments, &mut case_depth)?;
                self.index += 1;
                continue;
            }
            if (ch == '&' && (self.at(1) == Some('>') || current.ends_with('>')))
                || (ch == '|' && current.ends_with('>'))
            {
                current.push(ch);
                self.index += 1;
                continue;
            }
            if ch == '&' && self.at(1) != Some('&') {
                return None;
            }
            if ch == '\n' && !docs.is_empty() {
                let execute = current
                    .split(|ch: char| ch.is_whitespace() || ";&|<>".contains(ch))
                    .any(|word| {
                        ["sh", "bash", "dash", "ksh", "mksh", "zsh"]
                            .contains(&word.rsplit('/').next().unwrap_or(word))
                    });
                push(&mut current, &mut segments, &mut case_depth)?;
                self.index += 1;
                segments.extend(self.here_bodies(std::mem::take(&mut docs), execute, depth)?);
                continue;
            }
            if "&|;\n".contains(ch) {
                push(&mut current, &mut segments, &mut case_depth)?;
                self.index += if (ch == '&' || ch == '|') && self.at(1) == Some(ch) {
                    2
                } else {
                    1
                };
                continue;
            }
            current.push(ch);
            self.index += 1;
        }
        if end.is_some() || !docs.is_empty() {
            return None;
        }
        push(&mut current, &mut segments, &mut case_depth)?;
        if case_depth > 0 || segments.is_empty() {
            return None;
        }
        Some(segments)
    }
}

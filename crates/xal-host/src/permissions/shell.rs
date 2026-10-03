use super::split::segments;
use super::*;

#[derive(Clone)]
struct Word {
    text: String,
    dynamic: bool,
}

struct Invocation {
    name: Word,
    args: Vec<Word>,
}

struct Analysis {
    subjects: Vec<String>,
    risky: bool,
    unsupported: bool,
}

impl Permissions {
    pub(super) fn shell_policy(
        &self,
        command: &str,
        cwd: &Path,
        _: usize,
    ) -> Option<PolicyDecision> {
        let Some(segments) = segments(command) else {
            return Some(self.unsupported_shell());
        };
        let mut result = None;
        for segment in segments {
            let analysis = analyze(&segment, cwd, 0);
            if self.denied("bash", &segment)
                || analysis
                    .subjects
                    .iter()
                    .any(|subject| self.denied("bash", subject))
            {
                return Some(deny());
            }
            if analysis.unsupported && self.has_shell_denies() {
                return Some(deny());
            }
            let decision = self.matched("bash", &segment).or_else(|| {
                let mut allowed = false;
                for subject in analysis.subjects {
                    match self.matched("bash", &subject) {
                        Some(PolicyDecision::Ask(reason)) => {
                            return Some(PolicyDecision::Ask(reason));
                        }
                        Some(PolicyDecision::Allow) => allowed = true,
                        _ => {}
                    }
                }
                if analysis.risky || analysis.unsupported {
                    return Some(ask());
                }
                if allowed {
                    Some(PolicyDecision::Allow)
                } else {
                    None
                }
            });
            match decision {
                Some(PolicyDecision::Deny(reason)) => return Some(PolicyDecision::Deny(reason)),
                Some(PolicyDecision::Ask(reason)) => result = Some(PolicyDecision::Ask(reason)),
                Some(PolicyDecision::Allow) if result.is_none() => {
                    result = Some(PolicyDecision::Allow)
                }
                _ => {}
            }
        }
        result
    }

    fn has_shell_denies(&self) -> bool {
        self.denies
            .iter()
            .any(|rule| wildcard(rule.split('(').next().unwrap_or(rule).trim(), "bash"))
    }

    fn unsupported_shell(&self) -> PolicyDecision {
        if self.has_shell_denies() {
            deny()
        } else {
            ask()
        }
    }
}

fn ask() -> PolicyDecision {
    PolicyDecision::Ask(
        "This action needed approval but the session is headless, so it was not run.".into(),
    )
}
fn deny() -> PolicyDecision {
    PolicyDecision::Deny("Blocked by the active permission rules.".into())
}
fn basename(value: &str) -> &str {
    value.rsplit('/').next().unwrap_or(value)
}
fn assignment(value: &str) -> bool {
    value.split_once('=').is_some_and(|(name, _)| {
        name.chars()
            .next()
            .is_some_and(|ch| ch.is_ascii_alphabetic() || ch == '_')
            && name
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
    })
}
fn wrapper(name: &str) -> bool {
    [
        "builtin", "command", "env", "exec", "nohup", "nice", "stdbuf", "time", "timeout",
    ]
    .contains(&name)
}
fn shell(name: &str) -> bool {
    ["sh", "bash", "dash", "ksh", "mksh", "zsh"].contains(&name)
}
fn command_option(text: &str) -> bool {
    text.starts_with('-') && !text.starts_with("--") && text[1..].contains('c')
}
fn grouped_values(text: &str) -> usize {
    if (!text.starts_with('-') && !text.starts_with('+')) || text.starts_with("--") {
        return 0;
    }
    text[1..]
        .chars()
        .filter(|ch| *ch == 'o' || *ch == 'O')
        .count()
}

fn words(segment: &str) -> Vec<Word> {
    let mut words = Vec::new();
    let mut text = String::new();
    let mut dynamic = false;
    let mut quote = None;
    let mut started = false;
    let mut chars = segment.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\\' && quote != Some('\'') {
            if let Some(next) = chars.next()
                && next != '\n'
            {
                text.push(next);
                started = true;
            }
            continue;
        }
        if let Some(delimiter) = quote {
            if ch == delimiter {
                quote = None;
                continue;
            }
            if delimiter == '"' && (ch == '$' || ch == '`') {
                dynamic = true;
            }
            text.push(ch);
            continue;
        }
        if ch == '\'' || ch == '"' {
            quote = Some(ch);
            started = true;
            continue;
        }
        let redirect = ch == '>' || ch == '<' || (ch == '&' && chars.peek() == Some(&'>'));
        if ch.is_whitespace() || redirect {
            let descriptor =
                redirect && !text.is_empty() && text.bytes().all(|byte| byte.is_ascii_digit());
            let mut operator = if descriptor {
                std::mem::take(&mut text)
            } else {
                String::new()
            };
            if started && !descriptor {
                words.push(Word {
                    text: std::mem::take(&mut text),
                    dynamic,
                });
            }
            dynamic = false;
            started = false;
            if redirect {
                operator.push(ch);
                if ch == '&' {
                    operator.push(chars.next().unwrap());
                    if chars.peek() == Some(&'>') {
                        operator.push(chars.next().unwrap());
                    }
                } else if chars.peek().is_some_and(|next| {
                    *next == ch
                        || (ch == '>' && ['|', '&'].contains(next))
                        || (ch == '<' && *next == '>')
                }) {
                    operator.push(chars.next().unwrap());
                }
                words.push(Word {
                    text: operator,
                    dynamic: false,
                });
            }
            continue;
        }
        dynamic |= ['$', '`', '*', '?', '[', '{', '~'].contains(&ch);
        started = true;
        text.push(ch);
    }
    if started {
        words.push(Word { text, dynamic });
    }
    words
}

fn redirects(words: Vec<Word>) -> (Vec<Word>, Vec<Word>) {
    let mut remaining = Vec::new();
    let mut targets = Vec::new();
    let mut words = words.into_iter();
    while let Some(word) = words.next() {
        let operator = word.text.trim_start_matches(|ch: char| ch.is_ascii_digit());
        if !["&>", "&>>", ">", ">>", ">&", ">>&", ">|", "<>", "<", "<<"].contains(&operator) {
            remaining.push(word);
            continue;
        }
        if let Some(target) = words.next()
            && operator.contains('>')
            && !target.text.starts_with('&')
        {
            targets.push(target);
        }
    }
    (targets, remaining)
}

fn invocation(words: &[Word], index: usize) -> Invocation {
    Invocation {
        name: Word {
            text: basename(&words[index].text).into(),
            dynamic: words[index].dynamic,
        },
        args: words[index + 1..].to_vec(),
    }
}

fn candidates(words: &[Word], cwd: &Path) -> Option<Vec<Invocation>> {
    let mut result = Vec::new();
    let mut index = 0;
    while let Some(word) = words.get(index) {
        if assignment(&word.text) {
            index += 1;
            continue;
        }
        result.push(invocation(words, index));
        let name = basename(&word.text);
        if !wrapper(name) {
            break;
        }
        index = wrapper_end(words, index + 1, name, cwd)?;
    }
    if words
        .get(index)
        .is_some_and(|word| basename(&word.text) == "xargs")
    {
        let mut index = index + 1;
        while let Some(word) = words.get(index) {
            if word.text == "--" {
                index += 1;
                break;
            }
            if !word.text.starts_with('-') {
                break;
            }
            if [
                "-a",
                "--arg-file",
                "-d",
                "--delimiter",
                "-E",
                "--eof",
                "-I",
                "--replace",
                "-J",
                "-L",
                "--max-lines",
                "-n",
                "--max-args",
                "-P",
                "--max-procs",
                "-R",
                "-S",
                "-s",
                "--max-chars",
            ]
            .contains(&word.text.as_str())
            {
                index += 1;
            }
            index += 1;
        }
        if index < words.len() {
            result.extend(candidates(&words[index..], cwd)?);
        }
    }
    Some(result)
}

fn embedded(words: &[Word]) -> Option<Vec<String>> {
    let mut result = Vec::new();
    for (index, word) in words.iter().enumerate() {
        let name = basename(&word.text);
        let script = if name == "eval" {
            let args = &words[index + 1..];
            if args.iter().any(|word| word.dynamic) {
                return None;
            }
            Some(Word {
                text: args
                    .iter()
                    .map(|word| word.text.as_str())
                    .collect::<Vec<_>>()
                    .join(" "),
                dynamic: false,
            })
        } else if shell(name) {
            let mut script = None;
            for option in index + 1..words.len() {
                if !command_option(&words[option].text) {
                    continue;
                }
                let mut operand = option + 1 + grouped_values(&words[option].text);
                while let Some(word) = words.get(operand) {
                    if word.text == "--" {
                        operand += 1;
                        break;
                    }
                    if ["-O", "+O", "-o", "+o", "--init-file", "--rcfile"]
                        .contains(&word.text.as_str())
                    {
                        words.get(operand + 1)?;
                        operand += 2;
                        continue;
                    }
                    if word.text.starts_with("--init-file=") || word.text.starts_with("--rcfile=") {
                        operand += 1;
                        continue;
                    }
                    if word.text.starts_with("--") {
                        return None;
                    }
                    if !word.text.starts_with('-') && !word.text.starts_with('+') {
                        break;
                    }
                    operand += grouped_values(&word.text) + 1;
                }
                script = Some(words.get(operand)?.clone());
                break;
            }
            script
        } else {
            None
        };
        if let Some(script) = script {
            if script.dynamic {
                return None;
            }
            result.extend(segments(&script.text)?);
        }
    }
    Some(result)
}

fn escapes(word: &Word, cwd: &Path, destructive: bool) -> bool {
    if word.dynamic {
        return true;
    }
    if ["", "{}", ";", "+"].contains(&word.text.as_str()) {
        return false;
    }
    if word.text.starts_with('~') && word.text != "~" && !word.text.starts_with("~/") {
        return true;
    }
    #[cfg(windows)]
    if ["/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty"].contains(&word.text.as_str()) {
        return false;
    }
    let Ok(path) = resolve_path(cwd, &word.text) else {
        return true;
    };
    if ["/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty"]
        .iter()
        .any(|device| path == Path::new(device))
    {
        return false;
    }
    if path.starts_with(cwd) {
        return destructive && (path == cwd || path.starts_with(cwd.join(".git")));
    }
    ![std::env::temp_dir(), PathBuf::from("/tmp")]
        .iter()
        .any(|root| path.starts_with(root.canonicalize().unwrap_or_else(|_| root.clone())))
}

fn wrapper_end(words: &[Word], mut index: usize, name: &str, cwd: &Path) -> Option<usize> {
    let (flags, operands, long_flags, long_operands): (&str, &str, &[&str], &[&str]) = match name {
        "env" => (
            "i0v",
            "auCP",
            &["ignore-environment", "null", "debug", "help", "version"],
            &["argv0", "unset", "chdir"],
        ),
        "nice" => ("", "n", &["help", "version"], &["adjustment"]),
        "exec" => ("cl", "a", &[], &[]),
        "command" => ("pVv", "", &[], &[]),
        "builtin" => ("", "", &[], &[]),
        "nohup" => ("", "", &["help", "version"], &[]),
        "stdbuf" => (
            "",
            "ioe",
            &["help", "version"],
            &["input", "output", "error"],
        ),
        "time" => (
            "apqv",
            "fo",
            &[
                "append",
                "portability",
                "quiet",
                "verbose",
                "help",
                "version",
            ],
            &["format", "output"],
        ),
        "timeout" => (
            "v",
            "ks",
            &[
                "foreground",
                "preserve-status",
                "verbose",
                "help",
                "version",
            ],
            &["kill-after", "signal"],
        ),
        _ => return None,
    };
    while let Some(word) = words.get(index) {
        if word.text == "--" {
            index += 1;
            break;
        }
        if word.text == "-" && name == "env" {
            index += 1;
            continue;
        }
        if !word.text.starts_with('-') || word.text == "-" {
            break;
        }
        if let Some(option) = word.text.strip_prefix("--") {
            let (option, value) = option
                .split_once('=')
                .map_or((option, None), |(option, value)| (option, Some(value)));
            if long_operands.contains(&option) {
                let value = match value {
                    Some(value) => Word {
                        text: value.into(),
                        dynamic: word.dynamic,
                    },
                    None => {
                        index += 1;
                        words.get(index)?.clone()
                    }
                };
                if name == "env" && option == "chdir" && escapes(&value, cwd, false) {
                    return None;
                }
            } else if value.is_some() || !long_flags.contains(&option) {
                return None;
            }
            index += 1;
            continue;
        }
        if name == "nice" && word.text[1..].bytes().all(|byte| byte.is_ascii_digit()) {
            index += 1;
            continue;
        }
        let mut options = word.text[1..].chars();
        while let Some(option) = options.next() {
            if flags.contains(option) {
                if name == "command" && ['v', 'V'].contains(&option) {
                    return Some(words.len());
                }
                continue;
            }
            if !operands.contains(option) {
                return None;
            }
            let value = if options.as_str().is_empty() {
                index += 1;
                words.get(index)?.clone()
            } else {
                Word {
                    text: options.as_str().into(),
                    dynamic: word.dynamic,
                }
            };
            if name == "env" && option == 'C' && escapes(&value, cwd, false) {
                return None;
            }
            break;
        }
        index += 1;
    }
    if name == "timeout" {
        words.get(index)?;
        index += 1;
    }
    Some(index)
}

fn wrapper_escapes(words: &[Word], cwd: &Path) -> bool {
    words.iter().enumerate().any(|(index, word)| {
        if ["-C", "--chdir"].contains(&word.text.as_str()) {
            return words
                .get(index + 1)
                .is_none_or(|word| escapes(word, cwd, false));
        }
        word.text
            .strip_prefix("-C")
            .filter(|text| !text.is_empty())
            .or_else(|| word.text.strip_prefix("--chdir="))
            .is_some_and(|text| {
                escapes(
                    &Word {
                        text: text.into(),
                        dynamic: word.dynamic,
                    },
                    cwd,
                    false,
                )
            })
    })
}

fn invocation_escapes(invocation: &Invocation, cwd: &Path) -> bool {
    let name = &invocation.name;
    let args = &invocation.args;
    if name.dynamic {
        return true;
    }
    if shell(&name.text) {
        if args.iter().any(|word| command_option(&word.text)) {
            return false;
        }
        return args
            .iter()
            .find(|word| !word.text.starts_with('-'))
            .is_none_or(|word| escapes(word, cwd, false));
    }
    if name.text == "xargs" {
        return args.iter().any(|word| destructive(basename(&word.text)));
    }
    if name.text == "find" {
        if !args.iter().any(|word| {
            ["-delete", "-exec", "-execdir", "-ok", "-okdir"].contains(&word.text.as_str())
        }) {
            return false;
        }
        let roots = args
            .iter()
            .take_while(|word| !word.text.starts_with('-'))
            .collect::<Vec<_>>();
        return roots.is_empty() || roots.into_iter().any(|word| escapes(word, cwd, true));
    }
    [
        "rm", "rmdir", "mv", "cp", "mkdir", "touch", "chmod", "chown", "ln", "truncate", "shred",
        "tee", "cd", "pushd",
    ]
    .contains(&name.text.as_str())
        && args
            .iter()
            .any(|word| !word.text.starts_with('-') && escapes(word, cwd, destructive(&name.text)))
}

fn destructive(name: &str) -> bool {
    ["rm", "rmdir", "mv", "shred", "truncate"].contains(&name)
}

fn analyze(segment: &str, cwd: &Path, depth: usize) -> Analysis {
    if depth > 32 {
        return Analysis {
            subjects: Vec::new(),
            risky: true,
            unsupported: true,
        };
    }
    let words = words(segment);
    let mut risky = words.iter().any(|word| word.text.starts_with("CDPATH="));
    let (targets, words) = redirects(words);
    let wrapper_escape = wrapper_escapes(&words, cwd);
    risky |= targets.iter().any(|word| escapes(word, cwd, false)) || wrapper_escape;
    let candidates = candidates(&words, cwd);
    let unsupported = words.iter().chain(&targets).any(|word| word.dynamic)
        || wrapper_escape
        || candidates.is_none();
    let candidates = candidates.unwrap_or_default();
    risky |= candidates
        .iter()
        .any(|invocation| invocation_escapes(invocation, cwd));
    let subjects = candidates
        .iter()
        .map(|candidate| {
            std::iter::once(candidate.name.text.as_str())
                .chain(candidate.args.iter().map(|word| word.text.as_str()))
                .collect::<Vec<_>>()
                .join(" ")
        })
        .collect();
    let mut analysis = Analysis {
        subjects,
        risky,
        unsupported,
    };
    let Some(nested) = embedded(&words) else {
        analysis.unsupported = true;
        return analysis;
    };
    for segment in nested {
        let nested = analyze(&segment, cwd, depth + 1);
        analysis.subjects.push(segment);
        analysis.subjects.extend(nested.subjects);
        analysis.risky |= nested.risky;
        analysis.unsupported |= nested.unsupported;
    }
    analysis
}

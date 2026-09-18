use std::collections::{HashMap, HashSet};

use super::*;
use crate::redactor::SecretMatcher;

#[napi(object)]
pub struct NativeCodeSearchRedaction {
    pub values: Vec<String>,
    pub marker: String,
}

#[napi(object)]
pub struct NativeCodeSearchOptions {
    pub cwd: String,
    pub query: String,
    pub target: Option<String>,
    pub glob: Option<String>,
    pub redaction: Option<NativeCodeSearchRedaction>,
}

#[napi(object)]
#[derive(Clone)]
pub struct NativeCodePassage {
    pub path: String,
    pub start_line: u32,
    pub end_line: u32,
    pub text: String,
    pub score: f64,
}

#[napi(object)]
pub struct NativeCodeSearchResult {
    pub kind: NativeToolOutcomeKind,
    pub passages: Vec<NativeCodePassage>,
    pub scanned_files: u32,
    pub skipped_files: u32,
    pub skipped_lines: u32,
    pub matched_passages: u32,
    pub limited: bool,
}

fn words(text: &str) -> Vec<String> {
    let mut split = String::with_capacity(text.len());
    let mut previous_lower = false;
    for character in text.chars() {
        if character.is_uppercase() && previous_lower {
            split.push(' ');
        }
        previous_lower = character.is_lowercase() || character.is_numeric();
        split.extend(character.to_lowercase());
    }
    split
        .split(|character: char| !character.is_alphanumeric())
        .filter(|word| word.len() > 1)
        .map(str::to_owned)
        .collect()
}

fn query_words(query: &str) -> Vec<String> {
    let ignored: HashSet<&str> = [
        "the", "and", "for", "are", "how", "where", "what", "which", "does", "this", "that",
        "with", "from", "can", "its", "into", "when", "whether", "code", "find", "show", "me",
        "to", "of", "in", "is", "it", "be", "an", "on", "by", "at",
    ]
    .into_iter()
    .collect();
    let mut terms = words(query);
    terms.retain(|word| !ignored.contains(word.as_str()));
    terms.sort();
    terms.dedup();
    terms
}

fn word_matches(term: &str, word: &str) -> bool {
    term == word
        || (term.len() > 3 && term.strip_suffix('s') == Some(word))
        || (word.len() > 3 && word.strip_suffix('s') == Some(term))
        || (term.len() >= 6
            && word.len() >= 6
            && term
                .chars()
                .zip(word.chars())
                .take_while(|(a, b)| a == b)
                .count()
                >= 6)
}

fn passage_score(terms: &[String], path: &str, text: &str) -> f64 {
    let mut frequencies: HashMap<String, u32> = HashMap::new();
    for word in words(text) {
        *frequencies.entry(word).or_default() += 1;
    }
    let path_words = words(path);
    let mut score = 0.0;
    for term in terms {
        let hits: u32 = frequencies
            .iter()
            .filter(|(word, _)| word_matches(term, word))
            .map(|(_, count)| count)
            .sum();
        if hits > 0 {
            score += 2.0 + f64::from(hits.min(8)).ln_1p();
        }
        if path_words.iter().any(|word| word_matches(term, word)) {
            score += 1.5;
        }
    }
    score
}

fn eligible(path: &Path) -> bool {
    for part in path.components() {
        let Component::Normal(part) = part else {
            continue;
        };
        let name = part.to_string_lossy().to_lowercase();
        if matches!(name.as_str(), ".git" | ".ssh" | ".aws" | ".gnupg" | ".kube")
            || name == ".env"
            || name.starts_with(".env.")
            || name == "credentials"
            || name.starts_with("credentials.")
            || name == "secrets"
            || name.starts_with("secrets.")
            || name.starts_with("id_rsa")
            || name.starts_with("id_ed25519")
        {
            return false;
        }
    }
    !path.extension().is_some_and(|extension| {
        matches!(
            extension.to_string_lossy().to_lowercase().as_str(),
            "pem" | "key" | "p12" | "pfx" | "crt" | "cer" | "der" | "keystore"
        )
    })
}

fn checked_root(options: &NativeCodeSearchOptions) -> napi::Result<(PathBuf, PathBuf)> {
    let original_cwd = normalize_path(Path::new(&options.cwd));
    let cwd = fs::canonicalize(&original_cwd)?;
    let requested = absolute_target(&original_cwd, options.target.as_deref());
    let root = requested
        .strip_prefix(&original_cwd)
        .map_or_else(|_| requested.clone(), |relative| cwd.join(relative));
    if !root.starts_with(&cwd) {
        return Err(Error::from_reason(
            "code_search path must stay inside the workspace",
        ));
    }
    let mut current = cwd.clone();
    for part in root
        .strip_prefix(&cwd)
        .map_err(|error| Error::from_reason(error.to_string()))?
        .components()
    {
        current.push(part);
        if fs::symlink_metadata(&current)?.file_type().is_symlink() {
            return Err(Error::from_reason("code_search does not follow symlinks"));
        }
    }
    let root = fs::canonicalize(root)?;
    if !root.starts_with(&cwd) {
        return Err(Error::from_reason(
            "code_search path must stay inside the workspace",
        ));
    }
    Ok((cwd, root))
}

fn collect_passages(
    text: &str,
    path: &str,
    terms: &[String],
    result: &mut NativeCodeSearchResult,
    cancelled: &AtomicBool,
    deadline: Instant,
) {
    let lines: Vec<&str> = text.split_inclusive('\n').collect();
    let mut start = 0;
    while start < lines.len() {
        if cancelled.load(Ordering::Relaxed) || Instant::now() >= deadline {
            result.limited = true;
            break;
        }
        let mut end = start;
        let mut bytes = 0;
        while end < lines.len() && end - start < 40 && bytes + lines[end].len() <= 1800 {
            bytes += lines[end].len();
            end += 1;
        }
        if start == end {
            result.skipped_lines += 1;
            start += 1;
            continue;
        }
        let text = lines[start..end].concat();
        let score = passage_score(terms, path, &text);
        if score > 0.0 {
            result.matched_passages += 1;
            result.passages.push(NativeCodePassage {
                path: path.to_owned(),
                start_line: u32::try_from(start + 1).unwrap_or(u32::MAX),
                end_line: u32::try_from(end).unwrap_or(u32::MAX),
                text,
                score,
            });
            result.passages.sort_by(|left, right| {
                right
                    .score
                    .total_cmp(&left.score)
                    .then_with(|| left.path.cmp(&right.path))
                    .then_with(|| left.start_line.cmp(&right.start_line))
            });
            result.passages.truncate(40);
        }
        if end == lines.len() {
            break;
        }
        start = if end - start > 8 { end - 8 } else { end };
    }
}

pub struct CodeSearchTask {
    options: NativeCodeSearchOptions,
    cancelled: Arc<AtomicBool>,
}

impl Task for CodeSearchTask {
    type Output = NativeCodeSearchResult;
    type JsValue = NativeCodeSearchResult;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        let mut result = NativeCodeSearchResult {
            kind: NativeToolOutcomeKind::Completed,
            passages: Vec::new(),
            scanned_files: 0,
            skipped_files: 0,
            skipped_lines: 0,
            matched_passages: 0,
            limited: false,
        };
        let terms = query_words(&self.options.query);
        if terms.is_empty() || terms.len() > 64 || self.options.query.len() > 2000 {
            return Err(Error::from_reason(
                "code_search requires a query with 1 to 64 search terms and at most 2000 UTF-8 bytes",
            ));
        }
        let deadline = Instant::now() + Duration::from_secs(3);
        let matcher = self
            .options
            .redaction
            .as_ref()
            .filter(|redaction| !redaction.values.is_empty())
            .map(|redaction| {
                SecretMatcher::new(
                    redaction
                        .values
                        .iter()
                        .map(|value| value.encode_utf16().collect())
                        .collect(),
                    redaction.marker.encode_utf16().collect(),
                )
                .map_err(Error::from_reason)
            })
            .transpose()?;
        let (cwd, root) = checked_root(&self.options)?;
        let glob = self
            .options
            .glob
            .as_deref()
            .map(|pattern| {
                Glob::new(pattern)
                    .map(|glob| glob.compile_matcher())
                    .map_err(|error| Error::from_reason(error.to_string()))
            })
            .transpose()?;
        let walked = walk::walk_files_bounded(
            &cwd,
            &self.cancelled,
            Some(deadline),
            Some(20_000),
            Some(&root),
        )?;
        result.limited = walked.limited;
        let mut total_bytes = 0;
        for path in walked.files {
            if self.cancelled.load(Ordering::Relaxed) {
                result.kind = NativeToolOutcomeKind::Interrupted;
                result.passages.clear();
                return Ok(result);
            }
            if Instant::now() >= deadline || total_bytes >= 32 * 1024 * 1024 {
                result.limited = true;
                break;
            }
            if glob
                .as_ref()
                .is_some_and(|glob| !glob.is_match(path_for_glob(&path, &cwd, &root)))
            {
                continue;
            }
            if !eligible(path.strip_prefix(&cwd).unwrap_or(&path)) {
                result.skipped_files += 1;
                continue;
            }
            let canonical = fs::canonicalize(&path)?;
            if !canonical.starts_with(&cwd)
                || canonical != path
                || !fs::symlink_metadata(&path)?.is_file()
            {
                result.skipped_files += 1;
                continue;
            }
            let mut options = fs::OpenOptions::new();
            options.read(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
            }
            let mut file = options.open(&path)?;
            let metadata = file.metadata()?;
            if !metadata.is_file() || metadata.len() > 512 * 1024 {
                result.skipped_files += 1;
                continue;
            }
            let mut bytes = Vec::new();
            Read::by_ref(&mut file)
                .take(512 * 1024 + 1)
                .read_to_end(&mut bytes)?;
            total_bytes += bytes.len();
            if bytes.len() > 512 * 1024 || bytes.contains(&0) {
                result.skipped_files += 1;
                continue;
            }
            let Ok(text) = String::from_utf8(bytes) else {
                result.skipped_files += 1;
                continue;
            };
            let text = if let Some(matcher) = &matcher {
                String::from_utf16(&matcher.redact_lines(&text.encode_utf16().collect::<Vec<_>>()))
                    .map_err(|error| Error::from_reason(error.to_string()))?
            } else {
                text
            };
            result.scanned_files += 1;
            collect_passages(
                &text,
                &display_path(&path, &cwd),
                &terms,
                &mut result,
                &self.cancelled,
                deadline,
            );
        }
        if self.cancelled.load(Ordering::Relaxed) {
            result.kind = NativeToolOutcomeKind::Interrupted;
            result.passages.clear();
        }
        Ok(result)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(output)
    }
}

#[napi(js_name = "nativeCodeSearch", catch_unwind)]
pub fn native_code_search(
    options: NativeCodeSearchOptions,
    signal: Option<AbortSignal>,
) -> AsyncTask<CodeSearchTask> {
    AsyncTask::new(CodeSearchTask {
        options,
        cancelled: cancellation_flag(signal),
    })
}

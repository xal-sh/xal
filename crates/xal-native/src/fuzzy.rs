#![cfg_attr(test, allow(dead_code))]

use std::collections::HashSet;
use std::path::{MAIN_SEPARATOR, PathBuf};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

use napi::bindgen_prelude::{AbortSignal, AsyncTask};
use napi::{Env, Error, Status, Task};
use napi_derive::napi;

use crate::redactor::SecretMatcher;
use crate::search::walk_files;
use crate::tool_contracts::{NativeToolOutcomeKind, cancellation_flag};

const CONTIGUOUS_BONUS: f64 = 8.0;
const BOUNDARY_BONUS: f64 = 6.0;
const PREFIX_BONUS: f64 = 12.0;
const EXACT_BONUS: f64 = 20.0;
const GAP_PENALTY: f64 = 1.0;
const DISTANCE_PENALTY: f64 = 0.2;
const LENGTH_PENALTY: f64 = 0.05;
const WORKSPACE_RESULT_LIMIT: usize = 20;

#[napi(object)]
pub struct NativeFuzzyField {
    pub text: String,
    pub weight: f64,
}

#[napi(object)]
pub struct NativeFuzzyCandidate {
    pub fields: Vec<NativeFuzzyField>,
}

#[derive(Clone)]
struct Compact {
    chars: Vec<u16>,
    boundary: Vec<bool>,
}

#[derive(Clone)]
struct PreparedField {
    compact: Compact,
    weight: f64,
}

#[derive(Clone)]
struct WorkspaceEntry {
    path: String,
    fields: [PreparedField; 2],
}

fn is_separator(character: char) -> bool {
    matches!(
        character,
        ' ' | '\t' | '-' | '_' | '.' | '/' | '\\' | ':' | '@' | ',' | '(' | ')' | '[' | ']' | '|'
    )
}

fn is_digit(character: char) -> bool {
    character.is_ascii_digit()
}

fn compact(text: &str) -> Compact {
    let mut chars = Vec::new();
    let mut boundary = Vec::new();
    let mut previous = None;
    let mut after_separator = true;
    for character in text.chars() {
        if is_separator(character) {
            after_separator = true;
            continue;
        }
        let lower = character.to_lowercase().collect::<String>();
        let camel = previous.is_some_and(|previous: char| {
            character.to_string() != lower
                && previous.to_string() == previous.to_lowercase().collect::<String>()
        });
        let digit_shift =
            previous.is_some_and(|previous| is_digit(character) != is_digit(previous));
        for (index, unit) in lower.encode_utf16().enumerate() {
            chars.push(unit);
            boundary.push(index == 0 && (after_separator || camel || digit_shift));
        }
        previous = Some(character);
        after_separator = false;
    }
    Compact { chars, boundary }
}

fn terms(query: &str) -> Vec<Vec<u16>> {
    query
        .split_whitespace()
        .map(compact)
        .map(|value| value.chars)
        .filter(|value| !value.is_empty())
        .collect()
}

fn code_point_length(units: &[u16], position: usize) -> usize {
    let unit = units[position];
    if (0xd800..=0xdbff).contains(&unit)
        && units
            .get(position + 1)
            .is_some_and(|next| (0xdc00..=0xdfff).contains(next))
    {
        2
    } else {
        1
    }
}

fn find_units(haystack: &[u16], needle: &[u16], offset: usize) -> Option<usize> {
    haystack[offset..]
        .windows(needle.len())
        .position(|window| window == needle)
        .map(|position| position + offset)
}

fn score_term(term: &[u16], candidate: &Compact) -> Option<f64> {
    let mut end = 0;
    let mut position = 0;
    while position < term.len() {
        let length = code_point_length(term, position);
        let found = find_units(&candidate.chars, &term[position..position + length], end)?;
        end = found + 1;
        position += length;
    }
    let mut start = end;
    for unit in term.iter().rev() {
        start = candidate.chars[..start]
            .iter()
            .rposition(|candidate| candidate == unit)?;
    }
    let gaps = end - start - term.len();
    if gaps > term.len() * 2 + 4 {
        return None;
    }
    let mut score = term.len() as f64
        - gaps as f64 * GAP_PENALTY
        - start as f64 * DISTANCE_PENALTY
        - candidate.chars.len() as f64 * LENGTH_PENALTY;
    let mut cursor = start;
    let mut previous = None;
    let mut position = 0;
    while position < term.len() {
        let length = code_point_length(term, position);
        let at = find_units(&candidate.chars, &term[position..position + length], cursor)?;
        if previous.is_some_and(|previous| at == previous + 1) {
            score += CONTIGUOUS_BONUS;
        } else if candidate.boundary.get(at).copied().unwrap_or(false) {
            score += BOUNDARY_BONUS;
        }
        cursor = at + 1;
        previous = Some(at);
        position += length;
    }
    if start == 0 {
        score += PREFIX_BONUS;
    }
    if term.len() == candidate.chars.len() {
        score += EXACT_BONUS;
    }
    Some(score)
}

fn prepare(fields: Vec<NativeFuzzyField>) -> Vec<PreparedField> {
    fields
        .into_iter()
        .map(|field| PreparedField {
            compact: compact(&field.text),
            weight: field.weight,
        })
        .collect()
}

fn score_terms(query_terms: &[Vec<u16>], fields: &[PreparedField]) -> Option<f64> {
    if query_terms.is_empty() {
        return Some(0.0);
    }
    let mut total = 0.0;
    for term in query_terms {
        let best = fields
            .iter()
            .filter_map(|field| score_term(term, &field.compact).map(|score| score * field.weight))
            .max_by(f64::total_cmp)?;
        total += best;
    }
    Some(total)
}

#[napi(js_name = "nativeBatchScores", catch_unwind)]
pub fn native_batch_scores(query: String, candidates: Vec<NativeFuzzyCandidate>) -> Vec<f64> {
    let query_terms = terms(&query);
    candidates
        .into_iter()
        .map(|candidate| score_terms(&query_terms, &prepare(candidate.fields)).unwrap_or(f64::NAN))
        .collect()
}

#[napi(object)]
pub struct NativeWorkspaceSearchResult {
    pub kind: NativeToolOutcomeKind,
    pub paths: Vec<String>,
}

fn workspace_entry(path: String) -> WorkspaceEntry {
    let basename = path
        .trim_end_matches(['/', '\\'])
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(&path)
        .to_owned();
    WorkspaceEntry {
        fields: [
            PreparedField {
                compact: compact(&path),
                weight: 1.0,
            },
            PreparedField {
                compact: compact(&basename),
                weight: 1.5,
            },
        ],
        path,
    }
}

fn compare_paths(left: &str, right: &str) -> std::cmp::Ordering {
    let left_lower = left.to_lowercase();
    let right_lower = right.to_lowercase();
    left_lower.cmp(&right_lower).then_with(|| {
        for (left, right) in left.chars().zip(right.chars()) {
            if left == right {
                continue;
            }
            if left.to_lowercase().eq(right.to_lowercase()) {
                return left.is_uppercase().cmp(&right.is_uppercase());
            }
            return left.cmp(&right);
        }
        left.len().cmp(&right.len())
    })
}

fn rank_workspace(
    query: &str,
    entries: &[WorkspaceEntry],
    limit: usize,
    cancelled: Option<&AtomicBool>,
) -> Option<Vec<String>> {
    let query_terms = terms(query);
    let mut matches = Vec::<(f64, String)>::new();
    for entry in entries {
        if cancelled.is_some_and(|cancelled| cancelled.load(Ordering::Relaxed)) {
            return None;
        }
        let Some(score) = score_terms(&query_terms, &entry.fields) else {
            continue;
        };
        let position = matches.partition_point(|(existing_score, existing_path)| {
            *existing_score > score
                || (*existing_score == score && compare_paths(existing_path, &entry.path).is_lt())
        });
        if position < limit {
            matches.insert(position, (score, entry.path.clone()));
            matches.truncate(limit);
        }
    }
    Some(matches.into_iter().map(|(_, path)| path).collect())
}

#[napi]
pub struct NativePathRanker {
    entries: Vec<WorkspaceEntry>,
}

#[napi]
impl NativePathRanker {
    #[napi(constructor, catch_unwind)]
    pub fn new(paths: Vec<String>) -> Self {
        Self {
            entries: paths.into_iter().map(workspace_entry).collect(),
        }
    }

    #[napi(catch_unwind)]
    pub fn rank(&self, query: String, limit: u32) -> Vec<String> {
        rank_workspace(&query, &self.entries, limit as usize, None).unwrap_or_default()
    }
}

#[napi]
pub struct NativeWorkspaceIndex {
    entries: Arc<Vec<WorkspaceEntry>>,
}

pub struct WorkspaceIndexTask {
    cwd: PathBuf,
    values: Vec<String>,
    marker: String,
    cancelled: Arc<AtomicBool>,
}

impl Task for WorkspaceIndexTask {
    type Output = NativeWorkspaceIndex;
    type JsValue = NativeWorkspaceIndex;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        let matcher = if self.values.is_empty() {
            None
        } else {
            Some(
                SecretMatcher::new(
                    self.values
                        .iter()
                        .map(|value| value.encode_utf16().collect())
                        .collect(),
                    self.marker.encode_utf16().collect(),
                )
                .map_err(|reason| Error::new(Status::InvalidArg, reason))?,
            )
        };
        let files = walk_files(&self.cwd, &self.cancelled, None)?;
        if self.cancelled.load(Ordering::Relaxed) {
            return Err(Error::new(
                Status::Cancelled,
                "native operation interrupted",
            ));
        }
        let mut directories = HashSet::new();
        let mut paths = Vec::new();
        for file in files {
            if self.cancelled.load(Ordering::Relaxed) {
                return Err(Error::new(
                    Status::Cancelled,
                    "native operation interrupted",
                ));
            }
            let Ok(relative) = file.strip_prefix(&self.cwd) else {
                continue;
            };
            let path = relative.to_string_lossy().into_owned();
            if path.contains(['\r', '\n', '"']) || redacts(&matcher, &path) {
                continue;
            }
            let mut directory = relative.parent();
            while let Some(value) = directory {
                if value.as_os_str().is_empty() {
                    break;
                }
                let path = format!("{}{}", value.to_string_lossy(), MAIN_SEPARATOR);
                if !path.contains(['\r', '\n', '"']) && !redacts(&matcher, &path) {
                    directories.insert(path);
                }
                directory = value.parent();
            }
            paths.push(path);
        }
        paths.extend(directories);
        let entries = paths.into_iter().map(workspace_entry).collect();
        Ok(NativeWorkspaceIndex {
            entries: Arc::new(entries),
        })
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(output)
    }
}

fn redacts(matcher: &Option<SecretMatcher>, text: &str) -> bool {
    let Some(matcher) = matcher else {
        return false;
    };
    let units = text.encode_utf16().collect::<Vec<_>>();
    matcher.redact(&units) != units
}

#[napi(js_name = "createWorkspaceIndex", catch_unwind)]
pub fn create_workspace_index(
    cwd: String,
    values: Vec<String>,
    marker: String,
    signal: Option<AbortSignal>,
) -> AsyncTask<WorkspaceIndexTask> {
    AsyncTask::new(WorkspaceIndexTask {
        cwd: PathBuf::from(cwd),
        values,
        marker,
        cancelled: cancellation_flag(signal),
    })
}

pub struct WorkspaceSearchTask {
    entries: Arc<Vec<WorkspaceEntry>>,
    query: String,
    cancelled: Arc<AtomicBool>,
}

impl Task for WorkspaceSearchTask {
    type Output = NativeWorkspaceSearchResult;
    type JsValue = NativeWorkspaceSearchResult;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        let Some(paths) = rank_workspace(
            &self.query,
            &self.entries,
            WORKSPACE_RESULT_LIMIT,
            Some(&self.cancelled),
        ) else {
            return Ok(NativeWorkspaceSearchResult {
                kind: NativeToolOutcomeKind::Interrupted,
                paths: Vec::new(),
            });
        };
        Ok(NativeWorkspaceSearchResult {
            kind: NativeToolOutcomeKind::Completed,
            paths,
        })
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(output)
    }
}

#[napi]
impl NativeWorkspaceIndex {
    #[napi(catch_unwind)]
    pub fn search(
        &self,
        query: String,
        signal: Option<AbortSignal>,
    ) -> AsyncTask<WorkspaceSearchTask> {
        AsyncTask::new(WorkspaceSearchTask {
            entries: self.entries.clone(),
            query,
            cancelled: cancellation_flag(signal),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::{NativeFuzzyField, compact, compare_paths, prepare, score_terms, terms};

    fn score(query: &str, fields: Vec<(&str, f64)>) -> Option<f64> {
        score_terms(
            &terms(query),
            &prepare(
                fields
                    .into_iter()
                    .map(|(text, weight)| NativeFuzzyField {
                        text: text.to_owned(),
                        weight,
                    })
                    .collect(),
            ),
        )
    }

    #[test]
    fn handles_separators_camel_case_and_digits() {
        assert!(score("gpt5", vec![("gpt-5", 1.0)]).is_some());
        assert!(score("fb", vec![("fooBar", 1.0)]).is_some());
        assert!(compact("file20").boundary[4]);
    }

    #[test]
    fn handles_multiple_terms_and_weighted_fields() {
        assert!(score("google think", vec![("gemini", 1.0), ("google think", 0.4)]).is_some());
        assert!(score("missing think", vec![("google think", 1.0)]).is_none());
        assert!(
            score("codex", vec![("codex", 1.0)]).unwrap()
                > score("codex", vec![("codex", 0.4)]).unwrap()
        );
    }

    #[test]
    fn handles_unicode_and_empty_query_ties() {
        assert!(score("猫", vec![("src/猫.rs", 1.0)]).is_some());
        assert!(score("🔐", vec![("src/🔐.rs", 1.0)]).is_none());
        assert_eq!(score("  ", vec![("anything", 1.0)]), Some(0.0));
        let expanded = compact("İ/A");
        assert_eq!(expanded.chars.len(), expanded.boundary.len());
        assert_eq!(expanded.boundary, vec![true, false, true]);
        assert!(compare_paths("apps", "Cargo").is_lt());
        assert!(compare_paths("a", "A").is_lt());
    }
}

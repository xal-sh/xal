use super::*;

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
pub(super) struct Compact {
    chars: Vec<u16>,
    boundary: Vec<bool>,
}

#[derive(Clone)]
pub(super) struct PreparedField {
    pub(super) compact: Compact,
    pub(super) weight: f64,
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

pub(super) fn compact(text: &str) -> Compact {
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

pub(super) fn terms(query: &str) -> Vec<Vec<u16>> {
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

pub(super) fn score_terms(query_terms: &[Vec<u16>], fields: &[PreparedField]) -> Option<f64> {
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

#[cfg(test)]
mod tests {
    use super::{NativeFuzzyField, compact, prepare, score_terms, terms};

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
    }
}

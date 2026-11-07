use super::*;

const CR: u16 = b'\r' as u16;
const LF: u16 = b'\n' as u16;
const MAX_HINT_LINES: usize = 30;
const MAX_HINT_LINE_CHARS: usize = 300;
const MAX_MATCH_LINES: usize = 10;

#[napi(object)]
pub struct NativeEditOperation {
    pub old_string: Option<Utf16String>,
    pub new_string: Option<Utf16String>,
    pub replace_all: Option<bool>,
}

#[napi(object)]
pub struct NativeEditRequest {
    pub path: Option<String>,
    pub display_path: String,
    pub edits: Vec<NativeEditOperation>,
    pub expected: Option<String>,
}

#[napi(object)]
pub struct NativeEditOutput {
    pub output: Utf16String,
    pub content_hash: String,
    pub previous_content_hash: String,
}

struct Replacement {
    old: Vec<u16>,
    new: Vec<u16>,
    replace_all: bool,
}

struct Span {
    start: usize,
    end: usize,
    edit: usize,
}

fn match_positions(haystack: &[u16], needle: &[u16]) -> Vec<usize> {
    if needle.is_empty() {
        return Vec::new();
    }
    let mut positions = Vec::new();
    let mut cursor = 0;
    while cursor + needle.len() <= haystack.len() {
        let Some(relative) = haystack[cursor..]
            .windows(needle.len())
            .position(|window| window == needle)
        else {
            break;
        };
        let position = cursor + relative;
        positions.push(position);
        cursor = position + needle.len();
    }
    positions
}

fn apply_spans(previous: &[u16], spans: &[Span], replacements: &[Vec<u16>]) -> Vec<u16> {
    let mut next = Vec::with_capacity(previous.len());
    let mut cursor = 0;
    for span in spans {
        next.extend_from_slice(&previous[cursor..span.start]);
        next.extend_from_slice(&replacements[span.edit]);
        cursor = span.end;
    }
    next.extend_from_slice(&previous[cursor..]);
    next
}

fn overlapping_edits(spans: &[Span]) -> Option<(usize, usize)> {
    spans
        .windows(2)
        .find(|pair| pair[0].end > pair[1].start)
        .map(|pair| {
            (
                pair[0].edit.min(pair[1].edit),
                pair[0].edit.max(pair[1].edit),
            )
        })
}

fn edit_label(index: usize, count: usize) -> String {
    if count == 1 {
        String::new()
    } else {
        format!("edits[{index}]: ")
    }
}

fn has_crlf(units: &[u16]) -> bool {
    units.windows(2).any(|window| window == [CR, LF])
}

fn to_lf(units: &[u16]) -> Vec<u16> {
    let mut output = Vec::with_capacity(units.len());
    let mut index = 0;
    while index < units.len() {
        if units[index] == CR && units.get(index + 1) == Some(&LF) {
            output.push(LF);
            index += 2;
            continue;
        }
        output.push(units[index]);
        index += 1;
    }
    output
}

fn to_crlf(units: &[u16]) -> Vec<u16> {
    let lf = to_lf(units);
    let mut output = Vec::with_capacity(lf.len());
    for unit in lf {
        if unit == LF {
            output.push(CR);
            output.push(LF);
        } else {
            output.push(unit);
        }
    }
    output
}

fn align_newlines(haystack: &[u16], needle: &[u16]) -> Vec<u16> {
    if has_crlf(haystack) {
        to_crlf(needle)
    } else {
        to_lf(needle)
    }
}

fn read_line_prefix_len(line: &[u16]) -> Option<usize> {
    let mut index = 0;
    while index < line.len() && index < 5 && line[index] == b' ' as u16 {
        index += 1;
    }
    let digits_at = index;
    while index < line.len() && (b'0' as u16..=b'9' as u16).contains(&line[index]) {
        index += 1;
    }
    if index == digits_at || index < 6 {
        return None;
    }
    if line.get(index).copied() != Some(b':' as u16)
        || line.get(index + 1).copied() != Some(b' ' as u16)
    {
        return None;
    }
    Some(index + 2)
}

fn strip_read_prefixes(units: &[u16]) -> Option<Vec<u16>> {
    if units.is_empty() {
        return None;
    }
    let mut output = Vec::with_capacity(units.len());
    let mut start = 0;
    while start < units.len() {
        let relative = units[start..].iter().position(|&unit| unit == LF);
        let end = relative.map_or(units.len(), |index| start + index);
        let line = &units[start..end];
        let (content, cr) = if line.last() == Some(&CR) {
            (&line[..line.len() - 1], true)
        } else {
            (line, false)
        };
        let prefix = read_line_prefix_len(content)?;
        output.extend_from_slice(&content[prefix..]);
        if cr {
            output.push(CR);
        }
        if relative.is_some() {
            output.push(LF);
        }
        start = relative.map_or(units.len(), |_| end + 1);
    }
    Some(output)
}

fn resolve_match(previous: &[u16], old: &[u16], new: &[u16]) -> (Vec<u16>, Vec<u16>, Vec<usize>) {
    let aligned_new = align_newlines(previous, new);
    let positions = match_positions(previous, old);
    if !positions.is_empty() {
        return (old.to_vec(), aligned_new, positions);
    }

    let aligned_old = align_newlines(previous, old);
    if aligned_old != old {
        let positions = match_positions(previous, &aligned_old);
        if !positions.is_empty() {
            return (aligned_old, aligned_new, positions);
        }
    }

    let Some(stripped_old) = strip_read_prefixes(old) else {
        return (old.to_vec(), aligned_new, Vec::new());
    };
    let stripped_new = strip_read_prefixes(new).map_or_else(
        || aligned_new.clone(),
        |value| align_newlines(previous, &value),
    );
    let aligned_stripped_old = align_newlines(previous, &stripped_old);
    let positions = match_positions(previous, &aligned_stripped_old);
    (aligned_stripped_old, stripped_new, positions)
}

fn normalized_line(line: &str) -> String {
    line.chars()
        .filter(|value| !value.is_whitespace())
        .collect()
}

fn closest_match(text: &str, old: &str) -> Option<String> {
    let wanted = old.lines().map(normalized_line).collect::<Vec<_>>();
    let meaningful = wanted.iter().filter(|line| !line.is_empty()).count();
    let lines = text.lines().collect::<Vec<_>>();
    if meaningful == 0 || lines.is_empty() {
        return None;
    }
    let normalized = lines
        .iter()
        .map(|line| normalized_line(line))
        .collect::<Vec<_>>();
    let width = wanted.len().min(lines.len());
    let mut best = (0, 0);
    for start in 0..=lines.len() - width {
        let matched = wanted
            .iter()
            .take(width)
            .zip(&normalized[start..start + width])
            .filter(|(wanted, actual)| !wanted.is_empty() && wanted == actual)
            .count();
        if matched > best.1 {
            best = (start, matched);
        }
    }
    let (start, matched) = best;
    if matched * 2 < meaningful {
        return None;
    }
    let shown = width.min(MAX_HINT_LINES);
    let mut hint = format!(
        "The closest text is lines {}-{}, where {matched} of {meaningful} non-blank lines match ignoring whitespace:",
        start + 1,
        start + width
    );
    for (offset, line) in lines[start..start + shown].iter().enumerate() {
        let line = if line.chars().count() > MAX_HINT_LINE_CHARS {
            format!(
                "{}... [line truncated]",
                line.chars().take(MAX_HINT_LINE_CHARS).collect::<String>()
            )
        } else {
            (*line).to_owned()
        };
        hint.push_str(&format!("\n{:>6}: {line}", start + offset + 1));
    }
    if shown < width {
        hint.push_str(&format!("\n... {} more lines", width - shown));
    }
    Some(hint)
}

fn match_lines(text: &[u16], positions: &[usize]) -> String {
    let mut shown: Vec<String> = Vec::new();
    let mut distinct = 0;
    let mut previous = 0;
    let mut line = 1;
    let mut cursor = 0;
    for &position in positions {
        line += text[cursor..position]
            .iter()
            .filter(|&&unit| unit == LF)
            .count();
        cursor = position;
        if line == previous {
            continue;
        }
        previous = line;
        distinct += 1;
        if shown.len() < MAX_MATCH_LINES {
            shown.push(line.to_string());
        }
    }
    let mut listed = shown.join(", ");
    if distinct > MAX_MATCH_LINES {
        listed.push_str(&format!(", and {} more", distinct - MAX_MATCH_LINES));
    }
    listed
}

pub struct EditTask {
    path: PathBuf,
    display_path: String,
    edits: Vec<Replacement>,
    expected: Option<String>,
}

impl Task for EditTask {
    type Output = NativeEditOutput;
    type JsValue = NativeEditOutput;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        let metadata = fs::metadata(&self.path).map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                missing_file(&self.path, &self.display_path)
            } else {
                io_error(error)
            }
        })?;
        if metadata.is_dir() {
            return Err(failed(format!(
                "Path is a directory, not a file: {}",
                self.display_path
            )));
        }
        if !metadata.is_file() {
            return Err(failed(format!("Not a regular file: {}", self.display_path)));
        }
        if self.edits.iter().any(|edit| edit.replace_all) && self.expected.is_none() {
            return Err(failed(format!(
                "{} has not been read completely in this session. Read every line through direct read calls without truncation before replacing every occurrence, or use a targeted edit.",
                self.display_path
            )));
        }
        let previous_text =
            String::from_utf8(fs::read(&self.path).map_err(io_error)?).map_err(|error| {
                invalid(format!(
                    "Cannot edit binary file {}: {error}",
                    self.display_path
                ))
            })?;
        let previous_content_hash = content_hash(previous_text.as_bytes());
        if let Some(expected) = self.expected.as_deref()
            && previous_content_hash != expected
        {
            return Err(failed(format!(
                "{} changed since it was read. Read it again before replacing every occurrence.",
                self.display_path
            )));
        }
        let previous = previous_text.encode_utf16().collect::<Vec<_>>();
        let mut spans = Vec::new();
        let mut replacements = Vec::with_capacity(self.edits.len());
        for (index, edit) in self.edits.iter().enumerate() {
            let label = edit_label(index, self.edits.len());
            let (old, new, positions) = resolve_match(&previous, &edit.old, &edit.new);
            let matches = checked_count(positions.len(), "edit match")?;
            if positions.is_empty() {
                let message = format!(
                    "{label}old_string not found in {}. It must match the file text exactly, including whitespace and indentation.",
                    self.display_path
                );
                return Err(failed(
                    match closest_match(&previous_text, &utf16_lossy(&old)) {
                        Some(hint) => format!("{message} {hint}"),
                        None => message,
                    },
                ));
            }
            if positions.len() > 1 && !edit.replace_all {
                return Err(failed(format!(
                    "{label}old_string matches {matches} locations in {}, starting at lines {}. Add surrounding lines to make it unique, or set replace_all to true.",
                    self.display_path,
                    match_lines(&previous, &positions)
                )));
            }
            let count = if edit.replace_all { positions.len() } else { 1 };
            spans.extend(positions.into_iter().take(count).map(|start| Span {
                start,
                end: start + old.len(),
                edit: index,
            }));
            replacements.push(new);
        }
        spans.sort_by_key(|span| span.start);
        if let Some((first, second)) = overlapping_edits(&spans) {
            return Err(failed(format!(
                "edits[{first}] and edits[{second}] replace overlapping text in {}. Merge them into one edit.",
                self.display_path
            )));
        }
        let next = apply_spans(&previous, &spans, &replacements);
        let diff = unified_diff(&previous, &next);
        let bytes = utf16_lossy(&next);
        replace::replace_file(&self.path, bytes.as_bytes(), true).map_err(io_error)?;
        Ok(NativeEditOutput {
            output: with_diff(
                format!(
                    "Updated {} (+{} -{})",
                    self.display_path, diff.added, diff.removed
                ),
                &diff.hunks,
            )
            .into(),
            content_hash: content_hash(bytes.as_bytes()),
            previous_content_hash,
        })
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(output)
    }
}

#[napi(js_name = "nativeEditFile", catch_unwind)]
pub fn native_edit_file(request: NativeEditRequest) -> napi::Result<AsyncTask<EditTask>> {
    if request.edits.is_empty() {
        return Err(invalid("edits must contain at least one replacement"));
    }
    let count = request.edits.len();
    let edits = request
        .edits
        .into_iter()
        .enumerate()
        .map(|(index, edit)| {
            let label = edit_label(index, count);
            let old = edit
                .old_string
                .map(|old| old.to_vec())
                .filter(|old| !old.is_empty())
                .ok_or_else(|| {
                    invalid(format!(
                        "{label}old_string is required and must be non-empty"
                    ))
                })?;
            let new = edit
                .new_string
                .ok_or_else(|| invalid(format!("{label}new_string is required")))?
                .to_vec();
            if old == new {
                return Err(invalid(format!(
                    "{label}old_string and new_string are identical; nothing to change"
                )));
            }
            Ok(Replacement {
                old,
                new,
                replace_all: edit.replace_all.unwrap_or(false),
            })
        })
        .collect::<napi::Result<Vec<_>>>()?;
    Ok(AsyncTask::new(EditTask {
        path: required_path(request.path)?,
        display_path: request.display_path,
        edits,
        expected: request.expected,
    }))
}

#[cfg(test)]
mod tests {
    use super::{
        Span, align_newlines, apply_spans, closest_match, match_lines, match_positions,
        overlapping_edits, read_line_prefix_len, resolve_match, strip_read_prefixes, units,
    };

    fn span(start: usize, end: usize, edit: usize) -> Span {
        Span { start, end, edit }
    }

    #[test]
    fn points_at_the_closest_text_when_old_string_is_missing() {
        let text = "fn main() {\n    let total = 1;\n    println!(\"{total}\");\n}\n";
        assert_eq!(
            closest_match(
                text,
                "    let total=1;\n    println!(\"{total}\");\n    done();"
            )
            .as_deref(),
            Some(
                "The closest text is lines 2-4, where 2 of 3 non-blank lines match ignoring whitespace:\n     2:     let total = 1;\n     3:     println!(\"{total}\");\n     4: }"
            )
        );
        assert_eq!(closest_match(text, "unrelated\nlines\n"), None);
        let long = format!("needle\n{}\n", "x".repeat(1_000));
        let hint = closest_match(&long, "needle\nmissing").unwrap_or_default();
        assert!(hint.ends_with("... [line truncated]"));
        assert!(hint.len() < 500);
        assert_eq!(closest_match(text, "\n\n"), None);
    }

    #[test]
    fn counts_non_overlapping_utf16_matches() {
        let previous = units("same same same");
        let old = units("same");
        let positions = match_positions(&previous, &old);
        assert_eq!(positions, vec![0, 5, 10]);
        assert!(match_positions(&previous, &[]).is_empty());
    }

    #[test]
    fn applies_sorted_spans_and_reports_overlapping_edits() {
        let previous = units("alpha beta gamma");
        let spans = vec![span(0, 5, 1), span(11, 16, 0)];
        assert_eq!(
            apply_spans(&previous, &spans, &[units("three"), units("one")]),
            units("one beta three")
        );
        assert_eq!(overlapping_edits(&spans), None);
        let touching = vec![span(0, 5, 0), span(5, 6, 1)];
        assert_eq!(overlapping_edits(&touching), None);
        let overlapping = vec![span(0, 10, 2), span(6, 10, 1)];
        assert_eq!(overlapping_edits(&overlapping), Some((1, 2)));
    }

    #[test]
    fn lists_the_lines_where_ambiguous_matches_start() {
        let text = units("same\nother\nsame same\n");
        let positions = match_positions(&text, &units("same"));
        assert_eq!(match_lines(&text, &positions), "1, 3");
        let many = units(&"x\n".repeat(12));
        let positions = match_positions(&many, &units("x"));
        assert_eq!(
            match_lines(&many, &positions),
            "1, 2, 3, 4, 5, 6, 7, 8, 9, 10, and 2 more"
        );
    }

    #[test]
    fn detects_read_line_prefixes() {
        assert_eq!(read_line_prefix_len(&units("     1: code")), Some(8));
        assert_eq!(read_line_prefix_len(&units("    12: code")), Some(8));
        assert_eq!(read_line_prefix_len(&units("1000000: code")), Some(9));
        assert_eq!(read_line_prefix_len(&units("1: code")), None);
        assert_eq!(read_line_prefix_len(&units("code")), None);
    }

    #[test]
    fn strips_read_prefixes_only_when_every_line_has_them() {
        assert_eq!(
            strip_read_prefixes(&units("     1: alpha\n     2: beta\n")),
            Some(units("alpha\nbeta\n"))
        );
        assert_eq!(strip_read_prefixes(&units("     1: alpha\nbeta\n")), None);
        assert_eq!(
            strip_read_prefixes(&units("     1: alpha\r\n     2: beta")),
            Some(units("alpha\r\nbeta"))
        );
    }

    #[test]
    fn aligns_needle_newlines_to_the_file() {
        assert_eq!(
            align_newlines(&units("a\r\nb\r\n"), &units("a\nb\n")),
            units("a\r\nb\r\n")
        );
        assert_eq!(
            align_newlines(&units("a\nb\n"), &units("a\r\nb\r\n")),
            units("a\nb\n")
        );
        assert_eq!(
            align_newlines(&units("a\nb\n"), &units("a\rb\n")),
            units("a\rb\n")
        );
        assert_eq!(
            align_newlines(&units("a\r\nb\r\n"), &units("a\rb\n")),
            units("a\rb\r\n")
        );
    }

    #[test]
    fn resolve_match_keeps_exact_prefixed_file_content() {
        let previous = units("     1: kept\n");
        let (old, new, positions) = resolve_match(
            &previous,
            &units("     1: kept\n"),
            &units("     1: next\n"),
        );
        assert_eq!(positions, vec![0]);
        assert_eq!(old, units("     1: kept\n"));
        assert_eq!(new, units("     1: next\n"));
    }

    #[test]
    fn resolve_match_strips_read_prefixes_and_crlf() {
        let previous = units("alpha\r\nbeta\r\n");
        let (old, new, positions) = resolve_match(
            &previous,
            &units("     1: alpha\n     2: beta\n"),
            &units("     1: gamma\n     2: beta\n"),
        );
        assert_eq!(positions, vec![0]);
        assert_eq!(old, units("alpha\r\nbeta\r\n"));
        assert_eq!(new, units("gamma\r\nbeta\r\n"));
    }
}

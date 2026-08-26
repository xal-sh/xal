use super::*;

const CR: u16 = b'\r' as u16;
const LF: u16 = b'\n' as u16;

#[napi(object)]
pub struct NativeEditRequest {
    pub path: Option<String>,
    pub display_path: String,
    pub old_string: Option<Utf16String>,
    pub new_string: Option<Utf16String>,
    pub replace_all: Option<bool>,
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

fn replace_matches(
    previous: &[u16],
    old: &[u16],
    new: &[u16],
    positions: &[usize],
    replace_all: bool,
) -> Vec<u16> {
    let count = if replace_all { positions.len() } else { 1 };
    let mut next = Vec::with_capacity(previous.len());
    let mut cursor = 0;
    for position in positions.iter().take(count).copied() {
        next.extend_from_slice(&previous[cursor..position]);
        next.extend_from_slice(new);
        cursor = position + old.len();
    }
    next.extend_from_slice(&previous[cursor..]);
    next
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

pub struct EditTask {
    path: PathBuf,
    display_path: String,
    old: Vec<u16>,
    new: Vec<u16>,
    replace_all: bool,
}

impl Task for EditTask {
    type Output = NativeToolOutput;
    type JsValue = NativeToolOutput;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        let metadata = fs::metadata(&self.path)
            .map_err(|_| failed(format!("File not found: {}", self.display_path)))?;
        if metadata.is_dir() {
            return Err(failed(format!(
                "Path is a directory, not a file: {}",
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
        let previous = previous_text.encode_utf16().collect::<Vec<_>>();
        let (old, new, positions) = resolve_match(&previous, &self.old, &self.new);
        let matches = checked_count(positions.len(), "edit match")?;
        if positions.is_empty() {
            return Err(failed(format!(
                "old_string not found in {}. It must match the file text exactly, including whitespace and indentation.",
                self.display_path
            )));
        }
        if positions.len() > 1 && !self.replace_all {
            return Err(failed(format!(
                "old_string matches {matches} locations in {}. Add surrounding lines to make it unique, or set replace_all to true.",
                self.display_path
            )));
        }
        let next = replace_matches(&previous, &old, &new, &positions, self.replace_all);
        let diff = unified_diff(&previous, &next);
        fs::write(&self.path, utf16_lossy(&next).as_bytes()).map_err(io_error)?;
        Ok(NativeToolOutput {
            output: with_diff(
                format!(
                    "Updated {} (+{} -{})",
                    self.display_path, diff.added, diff.removed
                ),
                &diff.hunks,
            )
            .into(),
        })
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(output)
    }
}

#[napi(js_name = "nativeEditFile", catch_unwind)]
pub fn native_edit_file(request: NativeEditRequest) -> napi::Result<AsyncTask<EditTask>> {
    let old = request
        .old_string
        .ok_or_else(|| invalid("old_string is required and must be non-empty"))?;
    if old.is_empty() {
        return Err(invalid("old_string is required and must be non-empty"));
    }
    let new = request
        .new_string
        .ok_or_else(|| invalid("new_string is required"))?;
    if old.to_vec() == new.to_vec() {
        return Err(invalid(
            "old_string and new_string are identical; nothing to change",
        ));
    }
    Ok(AsyncTask::new(EditTask {
        path: required_path(request.path)?,
        display_path: request.display_path,
        old: old.to_vec(),
        new: new.to_vec(),
        replace_all: request.replace_all.unwrap_or(false),
    }))
}

#[cfg(test)]
mod tests {
    use super::{
        align_newlines, match_positions, read_line_prefix_len, replace_matches, resolve_match,
        strip_read_prefixes, units,
    };

    #[test]
    fn counts_non_overlapping_utf16_matches() {
        let previous = units("same same same");
        let old = units("same");
        let positions = match_positions(&previous, &old);
        assert_eq!(positions, vec![0, 5, 10]);
        assert_eq!(
            replace_matches(&previous, &old, &units("next"), &positions, true),
            units("next next next")
        );
        assert!(match_positions(&previous, &[]).is_empty());
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

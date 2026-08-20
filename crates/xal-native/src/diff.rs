const CONTEXT: usize = 3;
const MAX_DIFF_INPUT_LINES: usize = 2000;
const MAX_EDIT_DEPTH: usize = 1000;
const MAX_DIFF_LINES: usize = 200;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct DiffOutput {
    pub(crate) hunks: Vec<u16>,
    pub(crate) added: u32,
    pub(crate) removed: u32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum DiffOp {
    Same(Vec<u16>),
    Add(Vec<u16>),
    Remove(Vec<u16>),
}

fn split_lines(text: &[u16]) -> Vec<Vec<u16>> {
    if text.is_empty() {
        return Vec::new();
    }
    let mut lines = text
        .split(|unit| *unit == b'\n' as u16)
        .map(<[u16]>::to_vec)
        .collect::<Vec<_>>();
    if lines.last().is_some_and(Vec::is_empty) {
        lines.pop();
    }
    lines
}

fn backtrack(
    a: &[Vec<u16>],
    b: &[Vec<u16>],
    trace: &[Vec<isize>],
    depth: usize,
    offset: isize,
) -> Vec<DiffOp> {
    let mut ops = Vec::new();
    let mut x = a.len() as isize;
    let mut y = b.len() as isize;
    for d in (0..=depth).rev() {
        let v = &trace[d];
        let d = d as isize;
        let k = x - y;
        let down =
            k == -d || (k != d && v[(offset + k - 1) as usize] < v[(offset + k + 1) as usize]);
        let previous_k = if down { k + 1 } else { k - 1 };
        let previous_x = v[(offset + previous_k) as usize];
        let previous_y = previous_x - previous_k;
        while x > previous_x && y > previous_y {
            ops.push(DiffOp::Same(a[(x - 1) as usize].clone()));
            x -= 1;
            y -= 1;
        }
        if d > 0 {
            if down {
                ops.push(DiffOp::Add(b[previous_y as usize].clone()));
            } else {
                ops.push(DiffOp::Remove(a[previous_x as usize].clone()));
            }
        }
        x = previous_x;
        y = previous_y;
    }
    ops.reverse();
    ops
}

fn myers(a: &[Vec<u16>], b: &[Vec<u16>]) -> Option<Vec<DiffOp>> {
    let max = (a.len() + b.len()).min(MAX_EDIT_DEPTH);
    let offset = max as isize + 1;
    let mut v = vec![0_isize; max * 2 + 3];
    let mut trace = Vec::new();
    for depth in 0..=max {
        trace.push(v.clone());
        let d = depth as isize;
        let mut k = -d;
        while k <= d {
            let down =
                k == -d || (k != d && v[(offset + k - 1) as usize] < v[(offset + k + 1) as usize]);
            let mut x = if down {
                v[(offset + k + 1) as usize]
            } else {
                v[(offset + k - 1) as usize] + 1
            };
            let mut y = x - k;
            while x < a.len() as isize && y < b.len() as isize && a[x as usize] == b[y as usize] {
                x += 1;
                y += 1;
            }
            v[(offset + k) as usize] = x;
            if x >= a.len() as isize && y >= b.len() as isize {
                return Some(backtrack(a, b, &trace, depth, offset));
            }
            k += 2;
        }
    }
    None
}

fn prefixed(prefix: u16, text: &[u16]) -> Vec<u16> {
    let mut line = Vec::with_capacity(text.len() + 1);
    line.push(prefix);
    line.extend_from_slice(text);
    line
}

fn join_lines(lines: &[Vec<u16>]) -> Vec<u16> {
    let mut output = Vec::new();
    for (index, line) in lines.iter().enumerate() {
        if index > 0 {
            output.push(b'\n' as u16);
        }
        output.extend_from_slice(line);
    }
    output
}

fn render_hunks(ops: &[DiffOp]) -> DiffOutput {
    let mut include = vec![false; ops.len()];
    for (index, op) in ops.iter().enumerate() {
        if matches!(op, DiffOp::Same(_)) {
            continue;
        }
        let from = index.saturating_sub(CONTEXT);
        let to = (index + CONTEXT).min(ops.len().saturating_sub(1));
        include[from..=to].fill(true);
    }

    let mut lines = Vec::new();
    let mut added = 0_u32;
    let mut removed = 0_u32;
    let mut old_line = 1_usize;
    let mut new_line = 1_usize;
    let mut index = 0_usize;
    while index < ops.len() {
        if !include[index] {
            old_line += 1;
            new_line += 1;
            index += 1;
            continue;
        }
        let old_start = old_line;
        let new_start = new_line;
        let mut body = Vec::new();
        let mut old_count = 0_usize;
        let mut new_count = 0_usize;
        while index < ops.len() && include[index] {
            match &ops[index] {
                DiffOp::Same(text) => {
                    body.push(prefixed(b' ' as u16, text));
                    old_count += 1;
                    new_count += 1;
                    old_line += 1;
                    new_line += 1;
                }
                DiffOp::Remove(text) => {
                    body.push(prefixed(b'-' as u16, text));
                    old_count += 1;
                    old_line += 1;
                    removed += 1;
                }
                DiffOp::Add(text) => {
                    body.push(prefixed(b'+' as u16, text));
                    new_count += 1;
                    new_line += 1;
                    added += 1;
                }
            }
            index += 1;
        }
        let old_header = if old_count == 0 {
            old_start - 1
        } else {
            old_start
        };
        let new_header = if new_count == 0 {
            new_start - 1
        } else {
            new_start
        };
        lines.push(
            format!("@@ -{old_header},{old_count} +{new_header},{new_count} @@")
                .encode_utf16()
                .collect(),
        );
        lines.extend(body);
    }
    let hunks = if lines.len() <= MAX_DIFF_LINES {
        join_lines(&lines)
    } else {
        let omitted = lines.len() - MAX_DIFF_LINES;
        let mut visible = lines.into_iter().take(MAX_DIFF_LINES).collect::<Vec<_>>();
        visible.push(
            format!("… {omitted} more diff lines")
                .encode_utf16()
                .collect(),
        );
        join_lines(&visible)
    };
    DiffOutput {
        hunks,
        added,
        removed,
    }
}

pub(crate) fn unified_diff(old_text: &[u16], new_text: &[u16]) -> DiffOutput {
    let old_lines = split_lines(old_text);
    let new_lines = split_lines(new_text);
    let mut prefix = 0;
    while prefix < old_lines.len()
        && prefix < new_lines.len()
        && old_lines[prefix] == new_lines[prefix]
    {
        prefix += 1;
    }
    let mut suffix = 0;
    while suffix < old_lines.len() - prefix
        && suffix < new_lines.len() - prefix
        && old_lines[old_lines.len() - 1 - suffix] == new_lines[new_lines.len() - 1 - suffix]
    {
        suffix += 1;
    }

    let old_middle = &old_lines[prefix..old_lines.len() - suffix];
    let new_middle = &new_lines[prefix..new_lines.len() - suffix];
    if old_middle.is_empty() && new_middle.is_empty() {
        return DiffOutput {
            hunks: Vec::new(),
            added: 0,
            removed: 0,
        };
    }
    let middle =
        if old_middle.len() > MAX_DIFF_INPUT_LINES || new_middle.len() > MAX_DIFF_INPUT_LINES {
            None
        } else {
            myers(old_middle, new_middle)
        };
    let mut ops = old_lines[..prefix]
        .iter()
        .cloned()
        .map(DiffOp::Same)
        .collect::<Vec<_>>();
    if let Some(middle) = middle {
        ops.extend(middle);
    } else {
        ops.extend(old_middle.iter().cloned().map(DiffOp::Remove));
        ops.extend(new_middle.iter().cloned().map(DiffOp::Add));
    }
    ops.extend(
        old_lines[old_lines.len() - suffix..]
            .iter()
            .cloned()
            .map(DiffOp::Same),
    );
    render_hunks(&ops)
}

#[cfg(test)]
mod tests {
    use super::{DiffOutput, MAX_EDIT_DEPTH, unified_diff};

    fn diff(before: &str, after: &str) -> DiffOutput {
        unified_diff(
            &before.encode_utf16().collect::<Vec<_>>(),
            &after.encode_utf16().collect::<Vec<_>>(),
        )
    }

    fn text(units: &[u16]) -> String {
        String::from_utf16_lossy(units)
    }

    #[test]
    fn separates_distant_changes() {
        let before = (1..=12)
            .map(|line| format!("line {line}"))
            .collect::<Vec<_>>()
            .join("\n");
        let after = before
            .replace("line 2", "changed 2")
            .replace("line 11", "changed 11");
        assert_eq!(
            diff(&before, &after),
            super::DiffOutput {
                added: 2,
                removed: 2,
                hunks: "@@ -1,5 +1,5 @@\n line 1\n-line 2\n+changed 2\n line 3\n line 4\n line 5\n@@ -8,5 +8,5 @@\n line 8\n line 9\n line 10\n-line 11\n+changed 11\n line 12"
                    .encode_utf16()
                    .collect(),
            }
        );
    }

    #[test]
    fn renders_new_and_deleted_files() {
        assert_eq!(diff("", "alpha\nbeta\n").added, 2);
        assert_eq!(diff("alpha\nbeta\n", "").removed, 2);
    }

    #[test]
    fn falls_back_after_bounded_edit_depth() {
        let before = (0..MAX_EDIT_DEPTH + 1)
            .map(|line| format!("before {line}"))
            .collect::<Vec<_>>()
            .join("\n");
        let after = (0..MAX_EDIT_DEPTH + 1)
            .map(|line| format!("after {line}"))
            .collect::<Vec<_>>()
            .join("\n");
        let diff = diff(&before, &after);
        assert_eq!(diff.added, (MAX_EDIT_DEPTH + 1) as u32);
        assert_eq!(diff.removed, (MAX_EDIT_DEPTH + 1) as u32);
        assert!(text(&diff.hunks).ends_with("… 1803 more diff lines"));
    }
}

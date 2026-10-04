use super::*;

fn consume_csi(characters: &[char], mut cursor: usize) -> usize {
    while cursor < characters.len() {
        let character = characters[cursor];
        cursor += 1;
        if ('@'..='~').contains(&character) {
            break;
        }
    }
    cursor
}

fn consume_terminal_string(characters: &[char], mut cursor: usize, bell_terminated: bool) -> usize {
    while cursor < characters.len() {
        if bell_terminated && characters[cursor] == '\u{0007}' {
            return cursor + 1;
        }
        if characters[cursor] == '\u{009c}' {
            return cursor + 1;
        }
        if characters[cursor] == '\u{001b}' && characters.get(cursor + 1) == Some(&'\\') {
            return cursor + 2;
        }
        cursor += 1;
    }
    cursor
}

fn consume_escape(characters: &[char], mut cursor: usize) -> usize {
    let Some(introducer) = characters.get(cursor).copied() else {
        return cursor;
    };
    cursor += 1;
    match introducer {
        '[' => consume_csi(characters, cursor),
        ']' => consume_terminal_string(characters, cursor, true),
        'P' | 'X' | '^' | '_' => consume_terminal_string(characters, cursor, false),
        '\u{0020}'..='\u{002f}' => {
            while characters
                .get(cursor)
                .is_some_and(|character| ('\u{0020}'..='\u{002f}').contains(character))
            {
                cursor += 1;
            }
            if characters
                .get(cursor)
                .is_some_and(|character| ('\u{0030}'..='\u{007e}').contains(character))
            {
                cursor += 1;
            }
            cursor
        }
        _ => cursor,
    }
}

fn strip_terminal_controls(text: &str) -> String {
    let characters = text.chars().collect::<Vec<_>>();
    let mut output = String::new();
    let mut cursor = 0;
    while cursor < characters.len() {
        match characters[cursor] {
            '\u{001b}' => cursor = consume_escape(&characters, cursor + 1),
            '\u{009b}' => cursor = consume_csi(&characters, cursor + 1),
            '\u{009d}' => cursor = consume_terminal_string(&characters, cursor + 1, true),
            '\u{0090}' | '\u{0098}' | '\u{009e}' | '\u{009f}' => {
                cursor = consume_terminal_string(&characters, cursor + 1, false);
            }
            '\u{0080}'..='\u{009f}' => cursor += 1,
            character => {
                output.push(character);
                cursor += 1;
            }
        }
    }
    output
}

#[napi(js_name = "nativeNormalizeProcessOutput", catch_unwind)]
pub fn native_normalize_process_output(output: Utf16String) -> Utf16String {
    let source = String::from_utf16_lossy(&output).replace("\r\n", "\n");
    let stripped = strip_terminal_controls(&source);
    stripped
        .split('\n')
        .map(|line| {
            let line = line.rsplit_once('\r').map_or(line, |(_, tail)| tail);
            let mut normalized = Vec::new();
            for character in line.chars() {
                if character == '\u{0008}' {
                    normalized.pop();
                    continue;
                }
                if (character < ' ' && character != '\t') || character == '\u{007f}' {
                    continue;
                }
                normalized.push(character);
            }
            normalized.into_iter().collect::<String>()
        })
        .collect::<Vec<_>>()
        .join("\n")
        .into()
}
#[cfg(test)]
mod tests {
    use super::native_normalize_process_output;

    #[test]
    fn normalizes_terminal_output() {
        let output = native_normalize_process_output(
            "before\rreplace\n\u{001b}[31mred\u{001b}[0m\nab\u{0008}c"
                .to_owned()
                .into(),
        );
        assert_eq!(String::from_utf16_lossy(&output), "replace\nred\nac");
    }

    #[test]
    fn strips_extended_terminal_control_families() {
        let output = native_normalize_process_output(
            "a\u{009b}31mb\u{001b}Psecret\u{001b}\\c\u{001b}(0d\u{009d}title\u{009c}e"
                .to_owned()
                .into(),
        );
        assert_eq!(String::from_utf16_lossy(&output), "abcde");
    }
}

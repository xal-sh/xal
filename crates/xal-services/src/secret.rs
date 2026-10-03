use std::io;
use std::sync::atomic::{AtomicBool, Ordering};

#[derive(Clone, Copy)]
pub enum Mode {
    Hidden,
    Line,
    Text,
}

pub fn read(cancel: &AtomicBool, mode: Mode) -> io::Result<String> {
    let mut input = Input::open(matches!(mode, Mode::Hidden))?;
    let result = (|| {
        let mut bytes = Vec::new();
        loop {
            if cancel.load(Ordering::Acquire) {
                return Err(io::Error::new(
                    io::ErrorKind::Interrupted,
                    "input cancelled",
                ));
            }
            let byte = match input.byte() {
                Ok(Some(byte)) => byte,
                Ok(None) => continue,
                Err(error)
                    if error.kind() == io::ErrorKind::UnexpectedEof
                        && !matches!(mode, Mode::Hidden) =>
                {
                    break;
                }
                Err(error) => return Err(error),
            };
            match (mode, byte) {
                (Mode::Hidden | Mode::Line, b'\n' | b'\r') => break,
                (Mode::Hidden, 3 | 4) => {
                    return Err(io::Error::new(
                        io::ErrorKind::Interrupted,
                        "input cancelled",
                    ));
                }
                (Mode::Hidden, 8 | 127) => while bytes.pop().is_some_and(|b| b & 0xc0 == 0x80) {},
                (_, byte) => bytes.push(byte),
            }
            let maximum = if matches!(mode, Mode::Text) {
                8 * 1024 * 1024
            } else {
                32 * 1024
            };
            if bytes.len() > maximum {
                return Err(io::Error::other(format!("input exceeds {maximum} bytes")));
            }
        }
        String::from_utf8(bytes).map_err(io::Error::other)
    })();
    match (result, input.restore()) {
        (result, Ok(())) => result,
        (Ok(_), Err(error)) => Err(error),
        (Err(error), Err(restore)) => Err(io::Error::other(format!(
            "{error}; terminal restoration failed: {restore}"
        ))),
    }
}

#[cfg(unix)]
struct Input {
    original: Option<libc::termios>,
}
#[cfg(unix)]
impl Input {
    fn open(hidden: bool) -> io::Result<Self> {
        let mut input = Self { original: None };
        if hidden {
            let mut original = std::mem::MaybeUninit::uninit();
            if unsafe { libc::tcgetattr(0, original.as_mut_ptr()) } != 0 {
                return Err(io::Error::last_os_error());
            }
            let original = unsafe { original.assume_init() };
            let mut mode = original;
            mode.c_lflag &= !(libc::ECHO | libc::ICANON);
            mode.c_cc[libc::VMIN] = 1;
            mode.c_cc[libc::VTIME] = 0;
            if unsafe { libc::tcsetattr(0, libc::TCSANOW, &mode) } != 0 {
                return Err(io::Error::last_os_error());
            }
            input.original = Some(original);
        }
        Ok(input)
    }
    fn byte(&mut self) -> io::Result<Option<u8>> {
        let mut fd = libc::pollfd {
            fd: 0,
            events: libc::POLLIN,
            revents: 0,
        };
        let ready = unsafe { libc::poll(&mut fd, 1, 50) };
        if ready == 0 {
            return Ok(None);
        }
        if ready < 0 {
            let error = io::Error::last_os_error();
            return if error.kind() == io::ErrorKind::Interrupted {
                Ok(None)
            } else {
                Err(error)
            };
        }
        let mut byte = 0u8;
        let count = unsafe { libc::read(0, std::ptr::from_mut(&mut byte).cast(), 1) };
        if count == 0 {
            return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "input closed"));
        }
        if count < 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(Some(byte))
    }
    fn restore(&mut self) -> io::Result<()> {
        if let Some(original) = self.original
            && unsafe { libc::tcsetattr(0, libc::TCSANOW, &original) } != 0
        {
            return Err(io::Error::last_os_error());
        }
        self.original = None;
        Ok(())
    }
}

#[cfg(windows)]
struct Input {
    handle: windows_sys::Win32::Foundation::HANDLE,
    original: Option<u32>,
    pending: std::collections::VecDeque<u8>,
    high_surrogate: Option<u16>,
}
#[cfg(windows)]
impl Input {
    fn open(hidden: bool) -> io::Result<Self> {
        use windows_sys::Win32::System::Console::*;
        let handle = unsafe { GetStdHandle(STD_INPUT_HANDLE) };
        let mut original = 0;
        if hidden && unsafe { GetConsoleMode(handle, &mut original) } == 0 {
            return Err(io::Error::last_os_error());
        }
        if hidden
            && unsafe {
                SetConsoleMode(handle, original & !(ENABLE_ECHO_INPUT | ENABLE_LINE_INPUT))
            } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(Self {
            handle,
            original: hidden.then_some(original),
            pending: Default::default(),
            high_surrogate: None,
        })
    }
    fn byte(&mut self) -> io::Result<Option<u8>> {
        use windows_sys::Win32::{
            Foundation::{ERROR_BROKEN_PIPE, WAIT_OBJECT_0, WAIT_TIMEOUT},
            Storage::FileSystem::{FILE_TYPE_PIPE, GetFileType, ReadFile},
            System::{Console::*, Pipes::PeekNamedPipe, Threading::WaitForSingleObject},
        };
        if let Some(byte) = self.pending.pop_front() {
            return Ok(Some(byte));
        }
        let mut count = 0;
        if self.original.is_some() {
            match unsafe { WaitForSingleObject(self.handle, 50) } {
                WAIT_TIMEOUT => return Ok(None),
                WAIT_OBJECT_0 => {}
                _ => return Err(io::Error::last_os_error()),
            }
            let mut record = std::mem::MaybeUninit::<INPUT_RECORD>::uninit();
            if unsafe { ReadConsoleInputW(self.handle, record.as_mut_ptr(), 1, &mut count) } == 0 {
                return Err(io::Error::last_os_error());
            }
            if count == 0 {
                return Ok(None);
            }
            let record = unsafe { record.assume_init() };
            if u32::from(record.EventType) != KEY_EVENT {
                return Ok(None);
            }
            let key = unsafe { record.Event.KeyEvent };
            if key.bKeyDown == 0 {
                return Ok(None);
            }
            let unit = unsafe { key.uChar.UnicodeChar };
            if unit == 0 {
                return Ok(None);
            }
            if (0xd800..=0xdbff).contains(&unit) {
                self.high_surrogate = Some(unit);
                return Ok(None);
            }
            let units = match self.high_surrogate.take() {
                Some(high) => vec![high, unit],
                None => vec![unit],
            };
            let text = String::from_utf16(&units).map_err(io::Error::other)?;
            for _ in 0..key.wRepeatCount {
                self.pending.extend(text.bytes());
            }
            return Ok(self.pending.pop_front());
        }
        if unsafe { GetFileType(self.handle) } == FILE_TYPE_PIPE {
            let mut available = 0;
            if unsafe {
                PeekNamedPipe(
                    self.handle,
                    std::ptr::null_mut(),
                    0,
                    std::ptr::null_mut(),
                    &mut available,
                    std::ptr::null_mut(),
                )
            } == 0
            {
                let error = io::Error::last_os_error();
                if error.raw_os_error() == Some(ERROR_BROKEN_PIPE as i32) {
                    return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "input closed"));
                }
                return Err(error);
            }
            if available == 0 {
                std::thread::sleep(std::time::Duration::from_millis(50));
                return Ok(None);
            }
        }
        let mut byte = 0;
        if unsafe { ReadFile(self.handle, &mut byte, 1, &mut count, std::ptr::null_mut()) } == 0 {
            return Err(io::Error::last_os_error());
        }
        if count == 0 {
            return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "input closed"));
        }
        Ok(Some(byte))
    }
    fn restore(&mut self) -> io::Result<()> {
        if let Some(original) = self.original
            && unsafe { windows_sys::Win32::System::Console::SetConsoleMode(self.handle, original) }
                == 0
        {
            return Err(io::Error::last_os_error());
        }
        self.original = None;
        Ok(())
    }
}
impl Drop for Input {
    fn drop(&mut self) {
        if let Err(error) = self.restore() {
            eprintln!("terminal restoration failed: {error}");
        }
    }
}

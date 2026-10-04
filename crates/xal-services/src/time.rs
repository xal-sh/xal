pub fn timestamp(milliseconds: u64) -> std::io::Result<String> {
    if milliseconds > 253_402_300_799_999 {
        return Err(std::io::Error::other(
            "timestamp exceeds supported calendar range",
        ));
    }
    let mut days = (milliseconds / 1000) / 86400;
    let mut year = 1970u64;
    loop {
        let count = if leap(year) { 366 } else { 365 };
        if days < count {
            break;
        }
        days -= count;
        year += 1;
    }
    let months = [
        31,
        if leap(year) { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    let mut month = 1;
    for count in months {
        if days < count {
            break;
        }
        days -= count;
        month += 1;
    }
    let seconds = (milliseconds / 1000) % 86400;
    Ok(format!(
        "{year:04}-{month:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        days + 1,
        seconds / 3600,
        seconds / 60 % 60,
        seconds % 60,
        milliseconds % 1000
    ))
}
pub fn leap(year: u64) -> bool {
    year.is_multiple_of(4) && (!year.is_multiple_of(100) || year.is_multiple_of(400))
}

pub fn parse(value: &str) -> std::io::Result<u64> {
    let invalid = || std::io::Error::other("invalid calendar timestamp");
    if value.len() != 24 || !value.is_ascii() {
        return Err(invalid());
    }
    let year: u64 = value[..4].parse().map_err(|_| invalid())?;
    let month: usize = value[5..7].parse().map_err(|_| invalid())?;
    let day: u64 = value[8..10].parse().map_err(|_| invalid())?;
    if year < 1970 || !(1..=12).contains(&month) || day == 0 {
        return Err(invalid());
    }
    let months = [
        31,
        if leap(year) { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    let days = (1970..year)
        .map(|y| if leap(y) { 366 } else { 365 })
        .sum::<u64>()
        + months[..month - 1].iter().sum::<u64>()
        + day
        - 1;
    let number = |part: &str| part.parse::<u64>().map_err(|_| invalid());
    let result = days * 86_400_000
        + number(&value[11..13])? * 3_600_000
        + number(&value[14..16])? * 60_000
        + number(&value[17..19])? * 1000
        + number(&value[20..23])?;
    if timestamp(result)? != value {
        return Err(invalid());
    }
    Ok(result)
}

#[cfg(unix)]
pub fn local_date(milliseconds: u64) -> std::io::Result<String> {
    let seconds = (milliseconds / 1000)
        .try_into()
        .map_err(std::io::Error::other)?;
    let mut time = std::mem::MaybeUninit::<libc::tm>::uninit();
    if unsafe { libc::localtime_r(&seconds, time.as_mut_ptr()) }.is_null() {
        return Err(std::io::Error::last_os_error());
    }
    let time = unsafe { time.assume_init() };
    Ok(format!(
        "{:04}-{:02}-{:02}",
        time.tm_year + 1900,
        time.tm_mon + 1,
        time.tm_mday
    ))
}

#[cfg(windows)]
pub fn local_date(milliseconds: u64) -> std::io::Result<String> {
    use windows_sys::Win32::{
        Foundation::{FILETIME, SYSTEMTIME},
        System::Time::{FileTimeToSystemTime, SystemTimeToTzSpecificLocalTime},
    };
    let ticks = milliseconds
        .checked_add(11_644_473_600_000)
        .and_then(|ms| ms.checked_mul(10_000))
        .ok_or_else(|| std::io::Error::other("calendar timestamp out of range"))?;
    let time = FILETIME {
        dwLowDateTime: ticks as u32,
        dwHighDateTime: (ticks >> 32) as u32,
    };
    let mut utc = SYSTEMTIME::default();
    let mut local = SYSTEMTIME::default();
    if unsafe { FileTimeToSystemTime(&time, &mut utc) } == 0
        || unsafe { SystemTimeToTzSpecificLocalTime(std::ptr::null(), &utc, &mut local) } == 0
    {
        return Err(std::io::Error::last_os_error());
    }
    Ok(format!(
        "{:04}-{:02}-{:02}",
        local.wYear, local.wMonth, local.wDay
    ))
}

use std::fs::File;
use std::io;

#[cfg(unix)]
pub(super) fn copy_metadata(source: &File, destination: &File) -> io::Result<()> {
    use std::os::fd::AsRawFd;
    use std::os::unix::fs::MetadataExt;

    let original = source.metadata()?;
    let staged = destination.metadata()?;
    if (original.uid(), original.gid()) != (staged.uid(), staged.gid())
        && unsafe { libc::fchown(destination.as_raw_fd(), original.uid(), original.gid()) } != 0
    {
        return Err(io::Error::last_os_error());
    }
    copy_attributes(source, destination)?;
    destination.set_permissions(original.permissions())
}

#[cfg(target_os = "macos")]
fn copy_attributes(source: &File, destination: &File) -> io::Result<()> {
    use std::os::fd::AsRawFd;

    if unsafe {
        libc::fcopyfile(
            source.as_raw_fd(),
            destination.as_raw_fd(),
            std::ptr::null_mut(),
            libc::COPYFILE_ACL | libc::COPYFILE_XATTR,
        )
    } != 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn copy_attributes(source: &File, destination: &File) -> io::Result<()> {
    use std::ffi::CStr;
    use std::os::fd::AsRawFd;

    fn read_value(read: impl Fn(*mut libc::c_void, usize) -> isize) -> io::Result<Vec<u8>> {
        let length = read(std::ptr::null_mut(), 0);
        if length < 0 {
            return Err(io::Error::last_os_error());
        }
        let mut bytes = vec![0; usize::try_from(length).map_err(io::Error::other)?];
        let length = read(bytes.as_mut_ptr().cast(), bytes.len());
        if length < 0 {
            return Err(io::Error::last_os_error());
        }
        bytes.truncate(usize::try_from(length).map_err(io::Error::other)?);
        Ok(bytes)
    }

    let names = read_value(|buffer, length| unsafe {
        libc::flistxattr(source.as_raw_fd(), buffer.cast(), length)
    })?;
    let staged_names = read_value(|buffer, length| unsafe {
        libc::flistxattr(destination.as_raw_fd(), buffer.cast(), length)
    })?;
    for name in staged_names.split_inclusive(|byte| *byte == 0) {
        if names
            .split_inclusive(|byte| *byte == 0)
            .any(|original| original == name)
        {
            continue;
        }
        let name = CStr::from_bytes_with_nul(name).map_err(io::Error::other)?;
        if unsafe { libc::fremovexattr(destination.as_raw_fd(), name.as_ptr()) } != 0 {
            return Err(io::Error::last_os_error());
        }
    }
    for name in names.split_inclusive(|byte| *byte == 0) {
        let name = CStr::from_bytes_with_nul(name).map_err(io::Error::other)?;
        let value = read_value(|buffer, length| unsafe {
            libc::fgetxattr(source.as_raw_fd(), name.as_ptr(), buffer, length)
        })?;
        let existing = read_value(|buffer, length| unsafe {
            libc::fgetxattr(destination.as_raw_fd(), name.as_ptr(), buffer, length)
        });
        match existing {
            Ok(existing) if existing == value => continue,
            Ok(_) => {}
            Err(error) if error.raw_os_error() == Some(libc::ENODATA) => {}
            Err(error) => return Err(error),
        }
        if unsafe {
            libc::fsetxattr(
                destination.as_raw_fd(),
                name.as_ptr(),
                value.as_ptr().cast(),
                value.len(),
                0,
            )
        } != 0
        {
            return Err(io::Error::last_os_error());
        }
    }
    Ok(())
}

#[cfg(windows)]
pub(super) fn copy_metadata(source: &File, destination: &File) -> io::Result<()> {
    use std::ffi::c_void;
    use std::os::windows::io::AsRawHandle;

    #[link(name = "advapi32")]
    unsafe extern "system" {
        #[link_name = "GetKernelObjectSecurity"]
        fn get_security(
            handle: *mut c_void,
            information: u32,
            descriptor: *mut c_void,
            length: u32,
            needed: *mut u32,
        ) -> i32;
        #[link_name = "SetKernelObjectSecurity"]
        fn set_security(handle: *mut c_void, information: u32, descriptor: *const c_void) -> i32;
        #[link_name = "GetSecurityDescriptorControl"]
        fn get_control(descriptor: *const c_void, control: *mut u16, revision: *mut u32) -> i32;
    }

    let mut needed = 0;
    let result = unsafe {
        get_security(
            source.as_raw_handle(),
            7,
            std::ptr::null_mut(),
            0,
            &mut needed,
        )
    };
    if result == 0 && io::Error::last_os_error().raw_os_error() != Some(122) {
        return Err(io::Error::last_os_error());
    }
    let mut descriptor = vec![0u8; usize::try_from(needed).map_err(io::Error::other)?];
    if unsafe {
        get_security(
            source.as_raw_handle(),
            7,
            descriptor.as_mut_ptr().cast(),
            needed,
            &mut needed,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    let mut control = 0;
    let mut revision = 0;
    if unsafe { get_control(descriptor.as_ptr().cast(), &mut control, &mut revision) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let information = 7 | if control & 0x1000 != 0 {
        0x80000000
    } else {
        0x20000000
    };
    if unsafe {
        set_security(
            destination.as_raw_handle(),
            information,
            descriptor.as_ptr().cast(),
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    destination.set_permissions(source.metadata()?.permissions())
}

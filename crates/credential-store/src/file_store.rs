use crate::{Error, Result};
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use zeroize::Zeroizing;

const MAX_BYTES: u64 = 2 * 1024 * 1024;

#[cfg(not(test))]
pub(super) fn root() -> Result<PathBuf> {
    crate::lock_root()?
        .parent()
        .map(|directory| directory.join("secrets"))
        .ok_or(Error::Unavailable)
}

pub(super) fn path(root: &Path, service: &str, account: &str) -> PathBuf {
    let mut hash = Sha256::new();
    hash.update(service.as_bytes());
    hash.update([0]);
    hash.update(account.as_bytes());
    root.join(format!("{:x}", hash.finalize()))
}

fn io(error: std::io::Error) -> Error {
    match error.kind() {
        std::io::ErrorKind::NotFound => Error::Absent,
        std::io::ErrorKind::PermissionDenied => Error::Denied,
        _ => Error::Unavailable,
    }
}

fn private(metadata: &fs::Metadata, directory: bool) -> Result<()> {
    if metadata.file_type().is_symlink()
        || (if directory {
            !metadata.is_dir()
        } else {
            !metadata.is_file()
        })
        || metadata.uid() != nix::unistd::Uid::effective().as_raw()
        || metadata.mode() & 0o077 != 0
        || (!directory && metadata.nlink() != 1)
    {
        return Err(Error::Denied);
    }
    Ok(())
}

fn prepare(root: &Path, create: bool) -> Result<()> {
    let parent = root
        .parent()
        .filter(|parent| parent.is_absolute())
        .ok_or(Error::Unavailable)?;
    if create {
        let mut builder = fs::DirBuilder::new();
        builder.mode(0o700);
        match builder.create(parent) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(io(error)),
        }
    }
    let parent_metadata = fs::symlink_metadata(parent).map_err(io)?;
    if parent_metadata.file_type().is_symlink()
        || !parent_metadata.is_dir()
        || parent_metadata.uid() != nix::unistd::Uid::effective().as_raw()
    {
        return Err(Error::Denied);
    }
    if create {
        let mut builder = fs::DirBuilder::new();
        builder.mode(0o700);
        match builder.create(root) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(io(error)),
        }
    }
    private(&fs::symlink_metadata(root).map_err(io)?, true)
}

fn existing(path: &Path) -> Result<Option<fs::Metadata>> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            private(&metadata, false)?;
            Ok(Some(metadata))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(io(error)),
    }
}

pub(super) fn read(root: &Path, service: &str, account: &str) -> Result<Zeroizing<Vec<u8>>> {
    prepare(root, false)?;
    let path = path(root, service, account);
    let metadata = existing(&path)?.ok_or(Error::Absent)?;
    if metadata.len() > MAX_BYTES {
        return Err(Error::Corrupt);
    }
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_NONBLOCK)
        .open(path)
        .map_err(io)?;
    private(&file.metadata().map_err(io)?, false)?;
    let mut value = Zeroizing::new(Vec::with_capacity(metadata.len() as usize));
    file.take(MAX_BYTES + 1)
        .read_to_end(&mut value)
        .map_err(io)?;
    if value.len() as u64 > MAX_BYTES {
        return Err(Error::Corrupt);
    }
    Ok(value)
}

pub(super) fn write(
    root: &Path,
    service: &str,
    account: &str,
    value: &[u8],
    create_only: bool,
) -> Result<()> {
    if value.len() as u64 > MAX_BYTES {
        return Err(Error::Corrupt);
    }
    prepare(root, true)?;
    let path = path(root, service, account);
    if existing(&path)?.is_some() && create_only {
        return Err(Error::Occupied);
    }
    let mut temporary = tempfile::NamedTempFile::new_in(root).map_err(io)?;
    private(&temporary.as_file().metadata().map_err(io)?, false)?;
    temporary.write_all(value).map_err(io)?;
    temporary.as_file().sync_all().map_err(io)?;
    if create_only {
        temporary.persist_noclobber(path).map_err(|error| {
            if error.error.kind() == std::io::ErrorKind::AlreadyExists {
                Error::Occupied
            } else {
                io(error.error)
            }
        })?;
    } else {
        temporary.persist(path).map_err(|error| io(error.error))?;
    }
    File::open(root)
        .and_then(|directory| directory.sync_all())
        .map_err(io)
}

pub(super) fn remove(root: &Path, service: &str, account: &str) -> Result<()> {
    prepare(root, false)?;
    let path = path(root, service, account);
    existing(&path)?.ok_or(Error::Absent)?;
    fs::remove_file(path).map_err(io)?;
    File::open(root)
        .and_then(|directory| directory.sync_all())
        .map_err(io)
}

//! named pipe 저수준 I/O — **overlapped(중첩) 방식이어야 하는 이유**.
//!
//! ## 이 파일이 따로 있는 이유
//!
//! 파이프를 평범하게(동기 모드로) 열면 그 핸들의 입출력은 **줄을 서서** 처리된다.
//! 읽기 스레드와 쓰기 스레드를 따로 두어도 소용이 없다 — 읽기가 `ReadFile`에서 응답을
//! 기다리며 잠들면, 쓰기의 `WriteFile`은 그 뒤에 큐잉되어 나가지 못한다. 요청이 안
//! 나가니 서버는 응답할 것이 없고, 읽기는 영원히 깨지 않는다. 교착이다.
//!
//! 2026-08-04에 실제로 당했다: 악수(첫 요청)만 통하고 그다음 조회부터 응답이 오지
//! 않았다. 첫 요청은 읽기 스레드가 잠들기 **전에** 나갔던 것뿐이다.
//!
//! `FILE_FLAG_OVERLAPPED`로 열면 각 입출력이 자기 `OVERLAPPED` 구조체와 이벤트를 갖고
//! 독립적으로 진행한다. 두 방향이 서로를 기다리지 않는다. MSDN이 명시한다 —
//! *"a client cannot read and write simultaneously on the same handle unless overlapped
//! I/O is used."*
//!
//! ## 왜 `std::fs::File`을 쓰지 않는가
//!
//! `File`의 `read`/`write`는 핸들이 동기 모드라고 가정하고 `OVERLAPPED`를 넘기지 않는다.
//! overlapped 핸들에 그렇게 부르면 완료를 기다리지 않고 아직 안 채워진 버퍼를 읽게 된다.
//! 그래서 여기서는 핸들을 직접 다룬다.

use std::io;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};

use windows::core::PCWSTR;
use windows::Win32::Foundation::{
    ERROR_IO_PENDING, ERROR_OPERATION_ABORTED, GENERIC_READ, GENERIC_WRITE, HANDLE, WAIT_OBJECT_0,
};
use windows::Win32::Storage::FileSystem::{
    CreateFileW, ReadFile, WriteFile, FILE_FLAG_OVERLAPPED, FILE_SHARE_MODE, OPEN_EXISTING,
};
use windows::Win32::System::Threading::{CreateEventW, ResetEvent, WaitForSingleObject, INFINITE};
use windows::Win32::System::IO::{CancelIoEx, GetOverlappedResult, OVERLAPPED};

/// 파이프 핸들 하나. 읽기 스레드와 쓰기 스레드가 `Arc`로 나눠 갖는다.
///
/// `OwnedHandle`이 `Send + Sync`라 스레드 간 공유가 그대로 된다. 마지막 참조가
/// 사라질 때 핸들이 닫힌다.
pub struct Pipe {
    handle: OwnedHandle,
}

impl Pipe {
    pub fn open(name: &str) -> io::Result<Self> {
        let wide: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();

        let handle = unsafe {
            CreateFileW(
                PCWSTR(wide.as_ptr()),
                GENERIC_READ.0 | GENERIC_WRITE.0,
                FILE_SHARE_MODE(0),
                None,
                OPEN_EXISTING,
                // 이 플래그가 이 파일 전체의 존재 이유다. 빼면 읽기·쓰기가 서로를
                // 막아 두 번째 요청부터 교착한다.
                FILE_FLAG_OVERLAPPED,
                None,
            )
        }
        .map_err(to_io_error)?;

        Ok(Self {
            handle: unsafe { OwnedHandle::from_raw_handle(handle.0 as *mut std::ffi::c_void) },
        })
    }

    pub fn raw(&self) -> HANDLE {
        HANDLE(self.handle.as_raw_handle() as *mut std::ffi::c_void)
    }

    /// 진행 중인 입출력을 취소해 잠들어 있는 스레드를 깨운다.
    ///
    /// 핸들을 닫는 것만으로는 `ReadFile` 안에서 자고 있는 스레드가 깨지 않는다.
    pub fn cancel_all(&self) {
        unsafe {
            let _ = CancelIoEx(self.raw(), None);
        }
    }
}

/// 한 스레드가 쓰는 중첩 입출력 문맥.
///
/// **스레드마다 하나씩 가져야 한다.** 이벤트를 공유하면 한쪽의 완료 신호를 다른 쪽이
/// 가로채 아직 안 끝난 입출력을 끝난 것으로 오해한다.
pub struct Io {
    event: OwnedHandle,
}

impl Io {
    pub fn new() -> io::Result<Self> {
        // manual-reset(수동 초기화) 이벤트. 자동 초기화를 쓰면 `GetOverlappedResult`가
        // 기다릴 때 이미 소비된 신호를 다시 기다리게 된다.
        let event = unsafe { CreateEventW(None, true, false, None) }.map_err(to_io_error)?;
        Ok(Self {
            event: unsafe { OwnedHandle::from_raw_handle(event.0 as *mut std::ffi::c_void) },
        })
    }

    fn event_handle(&self) -> HANDLE {
        HANDLE(self.event.as_raw_handle() as *mut std::ffi::c_void)
    }

    /// 읽은 바이트 수. `Ok(0)`은 상대가 닫았다는 뜻이다.
    pub fn read(&self, pipe: &Pipe, buf: &mut [u8]) -> io::Result<usize> {
        let mut ov = OVERLAPPED::default();
        ov.hEvent = self.event_handle();
        unsafe { ResetEvent(self.event_handle()) }.map_err(to_io_error)?;

        let mut got = 0u32;
        let started = unsafe { ReadFile(pipe.raw(), Some(buf), Some(&mut got), Some(&mut ov)) };

        match started {
            // 즉시 끝났다 (버퍼에 이미 데이터가 있었다)
            Ok(()) => Ok(got as usize),
            Err(e) if e.code() == ERROR_IO_PENDING.to_hresult() => {
                self.wait(pipe, &ov)
            }
            Err(e) => Err(to_io_error(e)),
        }
    }

    pub fn write_all(&self, pipe: &Pipe, mut buf: &[u8]) -> io::Result<()> {
        while !buf.is_empty() {
            let mut ov = OVERLAPPED::default();
            ov.hEvent = self.event_handle();
            unsafe { ResetEvent(self.event_handle()) }.map_err(to_io_error)?;

            let mut put = 0u32;
            let started = unsafe { WriteFile(pipe.raw(), Some(buf), Some(&mut put), Some(&mut ov)) };

            let written = match started {
                Ok(()) => put as usize,
                Err(e) if e.code() == ERROR_IO_PENDING.to_hresult() => self.wait(pipe, &ov)?,
                Err(e) => return Err(to_io_error(e)),
            };

            if written == 0 {
                return Err(io::Error::new(io::ErrorKind::WriteZero, "파이프에 0바이트 기록"));
            }
            buf = &buf[written..];
        }
        Ok(())
    }

    /// 진행 중인 입출력이 끝나기를 기다린다.
    fn wait(&self, pipe: &Pipe, ov: &OVERLAPPED) -> io::Result<usize> {
        let waited = unsafe { WaitForSingleObject(self.event_handle(), INFINITE) };
        if waited != WAIT_OBJECT_0 {
            return Err(io::Error::other(format!("대기 실패: {:?}", waited.0)));
        }

        let mut done = 0u32;
        match unsafe { GetOverlappedResult(pipe.raw(), ov, &mut done, false) } {
            Ok(()) => Ok(done as usize),
            Err(e) if e.code() == ERROR_OPERATION_ABORTED.to_hresult() => {
                // `cancel_all`로 깨운 것이다. 오류가 아니라 종료 신호다.
                Ok(0)
            }
            Err(e) => Err(to_io_error(e)),
        }
    }
}

fn to_io_error(e: windows::core::Error) -> io::Error {
    io::Error::other(format!("{} (0x{:08X})", e.message(), e.code().0))
}

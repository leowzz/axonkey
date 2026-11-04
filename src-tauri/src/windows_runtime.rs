use std::{marker::PhantomData, sync::OnceLock};
use windows::{
    core::{Error, Result, HRESULT},
    Win32::System::Com::{
        CoIncrementMTAUsage, CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED,
    },
};

pub(crate) struct MtaApartment(PhantomData<*mut ()>);

pub(crate) fn initialize_mta() -> Result<MtaApartment> {
    static MTA: OnceLock<std::result::Result<(), HRESULT>> = OnceLock::new();
    // windows-rs caches WinRT factories for the process. Keep their MTA alive
    // when the last Bluetooth worker uninitializes COM between queries. This
    // process reference intentionally lasts until exit, just like the cache.
    (*MTA.get_or_init(|| {
        unsafe { CoIncrementMTAUsage() }
            .map(|_| ())
            .map_err(|e| e.code())
    }))
    .map_err(Error::from_hresult)?;
    unsafe { CoInitializeEx(None, COINIT_MULTITHREADED).ok()? };
    Ok(MtaApartment(PhantomData))
}

impl Drop for MtaApartment {
    fn drop(&mut self) {
        unsafe { CoUninitialize() };
    }
}

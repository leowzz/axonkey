use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::collections::{BTreeMap, HashMap};
use std::path::Path;
use std::sync::{mpsc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::Manager;
use uuid::Uuid;

static WRITER: OnceLock<mpsc::SyncSender<Message>> = OnceLock::new();
static LAST_TRIGGER: OnceLock<Mutex<HashMap<String, Instant>>> = OnceLock::new();
const DEBOUNCE: Duration = Duration::from_millis(250);

#[derive(Clone, Debug, Serialize, serde::Deserialize, PartialEq, Eq)]
pub(crate) struct UsageItem {
    item_id: String,
    addition_count: u64,
    execution_count: u64,
}

#[derive(Clone, Debug, Serialize, serde::Deserialize, PartialEq, Eq)]
pub(crate) struct UsageBatch {
    device_id: String,
    batch_id: String,
    items: Vec<UsageItem>,
}

enum Message {
    Event {
        kind: &'static str,
        input: String,
        sources: Vec<String>,
        at_ms: i64,
    },
    VoiceStart {
        key: String,
        mode: String,
        at_ms: i64,
        at: Instant,
    },
    VoiceStop {
        key: String,
        at_ms: i64,
        at: Instant,
    },
    Take(mpsc::Sender<Result<Option<UsageBatch>, String>>),
    Ack(String, mpsc::Sender<Result<(), String>>),
}

pub(crate) fn initialize(app: &tauri::AppHandle) {
    let directory = match app.path().app_data_dir() {
        Ok(path) => path,
        Err(error) => {
            log::warn!("Cannot locate usage database: {error}");
            return;
        }
    };
    let (sender, receiver) = mpsc::sync_channel(4096);
    if WRITER.set(sender).is_err() {
        return;
    }
    std::thread::spawn(move || {
        let result = (|| -> Result<(), String> {
            std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
            let mut store =
                Store::open(&directory.join("usage.sqlite3")).map_err(|e| e.to_string())?;
            let mut write_failed = false;
            while let Ok(message) = receiver.recv() {
                match message {
                    Message::Take(reply) => {
                        let _ = reply.send(store.take().map_err(|e| e.to_string()));
                    }
                    Message::Ack(id, reply) => {
                        let _ = reply.send(store.ack(&id).map_err(|e| e.to_string()));
                    }
                    event => match store.record(event) {
                        Ok(()) => write_failed = false,
                        Err(error) => {
                            if !write_failed {
                                log::warn!("Cannot save usage event: {error}");
                            }
                            write_failed = true;
                        }
                    },
                }
            }
            Ok(())
        })();
        if let Err(error) = result {
            log::warn!("Usage database unavailable: {error}");
        }
    });
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn send(message: Message) {
    if let Some(writer) = WRITER.get() {
        let _ = writer.try_send(message);
    }
}

fn accept_trigger(last: &mut HashMap<String, Instant>, input: &str, now: Instant) -> bool {
    if last
        .get(input)
        .is_some_and(|at| now.duration_since(*at) < DEBOUNCE)
    {
        return false;
    }
    last.insert(input.to_owned(), now);
    true
}

pub(crate) fn record_trigger(input: &str, sources: &[String]) {
    let Ok(mut last) = LAST_TRIGGER
        .get_or_init(|| Mutex::new(HashMap::new()))
        .try_lock()
    else {
        return;
    };
    if !accept_trigger(&mut last, input, Instant::now()) {
        return;
    }
    send(Message::Event {
        kind: "trigger",
        input: input.into(),
        sources: sources.to_vec(),
        at_ms: now_ms(),
    });
}

pub(crate) fn voice_start(key: &str, mode: &str) {
    send(Message::VoiceStart {
        key: key.into(),
        mode: mode.into(),
        at_ms: now_ms(),
        at: Instant::now(),
    });
}

pub(crate) fn voice_stop(key: &str) {
    send(Message::VoiceStop {
        key: key.into(),
        at_ms: now_ms(),
        at: Instant::now(),
    });
}

#[tauri::command]
pub(crate) fn axonkey_record_library_additions(item_ids: Vec<String>) -> Result<(), String> {
    if item_ids.len() > 100 || item_ids.iter().any(|id| Uuid::parse_str(id).is_err()) {
        return Err("无效的行为来源".into());
    }
    for item_id in item_ids {
        send(Message::Event {
            kind: "addition",
            input: String::new(),
            sources: vec![item_id],
            at_ms: now_ms(),
        });
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn axonkey_take_library_usage() -> Result<Option<UsageBatch>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let (reply, receiver) = mpsc::channel();
        WRITER
            .get()
            .ok_or("本地使用统计未就绪")?
            .try_send(Message::Take(reply))
            .map_err(|_| "本地使用统计暂不可用")?;
        receiver
            .recv_timeout(Duration::from_secs(2))
            .map_err(|_| "读取本地使用统计超时")?
    })
    .await
    .map_err(|_| "读取本地使用统计失败")?
}

#[tauri::command]
pub(crate) async fn axonkey_ack_library_usage(batch_id: String) -> Result<(), String> {
    if Uuid::parse_str(&batch_id).is_err() {
        return Err("无效的统计批次".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let (reply, receiver) = mpsc::channel();
        WRITER
            .get()
            .ok_or("本地使用统计未就绪")?
            .try_send(Message::Ack(batch_id, reply))
            .map_err(|_| "本地使用统计暂不可用")?;
        receiver
            .recv_timeout(Duration::from_secs(2))
            .map_err(|_| "确认本地使用统计超时")?
    })
    .await
    .map_err(|_| "确认本地使用统计失败")?
}

struct Store {
    connection: Connection,
    voices: HashMap<String, (i64, Instant)>,
}

impl Store {
    fn open(path: &Path) -> rusqlite::Result<Self> {
        let connection = Connection::open(path)?;
        connection.busy_timeout(Duration::from_millis(100))?;
        connection.pragma_update(None, "journal_mode", "WAL")?;
        connection.pragma_update(None, "synchronous", "NORMAL")?;
        connection.execute_batch("CREATE TABLE IF NOT EXISTS usage_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS usage_events (id INTEGER PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('addition','trigger')), input_key TEXT NOT NULL, created_at_ms INTEGER NOT NULL);
            CREATE INDEX IF NOT EXISTS usage_events_time_idx ON usage_events(created_at_ms);
            CREATE TABLE IF NOT EXISTS usage_event_sources (event_id INTEGER NOT NULL, item_id TEXT NOT NULL, batch_id TEXT, synced_at_ms INTEGER, PRIMARY KEY(event_id,item_id));
            CREATE INDEX IF NOT EXISTS usage_sources_pending_idx ON usage_event_sources(event_id) WHERE synced_at_ms IS NULL;
            CREATE INDEX IF NOT EXISTS usage_sources_item_idx ON usage_event_sources(item_id,event_id);
            CREATE TABLE IF NOT EXISTS usage_upload_batches (batch_id TEXT PRIMARY KEY, payload TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS voice_sessions (id INTEGER PRIMARY KEY, input_key TEXT NOT NULL, mode TEXT NOT NULL CHECK(mode IN ('hold','click')), started_at_ms INTEGER NOT NULL, ended_at_ms INTEGER, duration_ms INTEGER, status TEXT NOT NULL CHECK(status IN ('recording','completed','interrupted')));
            CREATE INDEX IF NOT EXISTS voice_sessions_time_idx ON voice_sessions(started_at_ms);
            UPDATE voice_sessions SET status='interrupted' WHERE status='recording';")?;
        connection.execute(
            "INSERT OR IGNORE INTO usage_meta(key,value) VALUES('device_id',?1)",
            [Uuid::new_v4().to_string()],
        )?;
        connection.pragma_update(None, "user_version", 1)?;
        Ok(Self {
            connection,
            voices: HashMap::new(),
        })
    }

    fn record(&mut self, message: Message) -> rusqlite::Result<()> {
        match message {
            Message::Event {
                kind,
                input,
                sources,
                at_ms,
            } => {
                let transaction = self.connection.transaction()?;
                transaction.execute(
                    "INSERT INTO usage_events(kind,input_key,created_at_ms) VALUES(?1,?2,?3)",
                    params![kind, input, at_ms],
                )?;
                let id = transaction.last_insert_rowid();
                for item in sources {
                    transaction.execute(
                        "INSERT OR IGNORE INTO usage_event_sources(event_id,item_id) VALUES(?1,?2)",
                        params![id, item],
                    )?;
                }
                transaction.commit()?;
            }
            Message::VoiceStart {
                key,
                mode,
                at_ms,
                at,
            } => {
                if !self.voices.contains_key(&key) {
                    self.connection.execute("INSERT INTO voice_sessions(input_key,mode,started_at_ms,status) VALUES(?1,?2,?3,'recording')", params![key,mode,at_ms])?;
                    self.voices
                        .insert(key, (self.connection.last_insert_rowid(), at));
                }
            }
            Message::VoiceStop { key, at_ms, at } => {
                if let Some((id, started)) = self.voices.remove(&key) {
                    self.connection.execute("UPDATE voice_sessions SET ended_at_ms=?1,duration_ms=?2,status='completed' WHERE id=?3", params![at_ms,at.duration_since(started).as_millis() as i64,id])?;
                }
            }
            _ => unreachable!(),
        }
        Ok(())
    }

    fn take(&mut self) -> rusqlite::Result<Option<UsageBatch>> {
        let pending: Option<String> = self
            .connection
            .query_row(
                "SELECT payload FROM usage_upload_batches LIMIT 1",
                [],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(payload) = pending {
            return serde_json::from_str(&payload).map(Some).map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(
                    0,
                    rusqlite::types::Type::Text,
                    Box::new(error),
                )
            });
        }
        let transaction = self.connection.transaction()?;
        let rows: Vec<(i64, String, String)> = {
            let mut statement = transaction.prepare("SELECT s.event_id,s.item_id,e.kind FROM usage_event_sources s JOIN usage_events e ON e.id=s.event_id WHERE s.synced_at_ms IS NULL AND s.batch_id IS NULL ORDER BY s.event_id LIMIT 10000")?;
            let rows = statement
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            rows
        };
        let mut items: BTreeMap<String, UsageItem> = BTreeMap::new();
        let mut selected = Vec::new();
        for (event_id, item_id, kind) in rows {
            if !items.contains_key(&item_id) && items.len() == 100 {
                break;
            }
            let item = items.entry(item_id.clone()).or_insert_with(|| UsageItem {
                item_id: item_id.clone(),
                addition_count: 0,
                execution_count: 0,
            });
            if kind == "addition" {
                item.addition_count += 1;
            } else {
                item.execution_count += 1;
            }
            selected.push((event_id, item_id));
        }
        if items.is_empty() {
            return Ok(None);
        }
        let batch = UsageBatch {
            device_id: transaction.query_row(
                "SELECT value FROM usage_meta WHERE key='device_id'",
                [],
                |row| row.get(0),
            )?,
            batch_id: Uuid::new_v4().to_string(),
            items: items.into_values().collect(),
        };
        transaction.execute(
            "INSERT INTO usage_upload_batches(batch_id,payload) VALUES(?1,?2)",
            params![
                batch.batch_id,
                serde_json::to_string(&batch).expect("usage batch serialization")
            ],
        )?;
        for (event_id, item_id) in selected {
            transaction.execute(
                "UPDATE usage_event_sources SET batch_id=?1 WHERE event_id=?2 AND item_id=?3",
                params![batch.batch_id, event_id, item_id],
            )?;
        }
        transaction.commit()?;
        Ok(Some(batch))
    }

    fn ack(&mut self, batch_id: &str) -> rusqlite::Result<()> {
        let transaction = self.connection.transaction()?;
        transaction.execute(
            "UPDATE usage_event_sources SET synced_at_ms=?1 WHERE batch_id=?2",
            params![now_ms(), batch_id],
        )?;
        transaction.execute(
            "DELETE FROM usage_upload_batches WHERE batch_id=?1",
            [batch_id],
        )?;
        transaction.commit()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn event(kind: &'static str, sources: &[&str]) -> Message {
        Message::Event {
            kind,
            input: "remote:power:click".into(),
            sources: sources.iter().map(|value| value.to_string()).collect(),
            at_ms: 1,
        }
    }
    #[test]
    fn batches_survive_restart_and_only_acknowledge_the_selected_events() {
        let path = std::env::temp_dir().join(format!("axonkey-usage-{}.sqlite3", Uuid::new_v4()));
        let mut store = Store::open(&path).unwrap();
        store.record(event("addition", &["one"])).unwrap();
        store
            .record(event("trigger", &["one", "one", "two"]))
            .unwrap();
        let batch = store.take().unwrap().unwrap();
        assert_eq!(batch.items[0].addition_count, 1);
        assert_eq!(batch.items[0].execution_count, 1);
        store.record(event("trigger", &["one"])).unwrap();
        assert_eq!(store.take().unwrap().unwrap(), batch);
        drop(store);
        let mut store = Store::open(&path).unwrap();
        assert_eq!(store.take().unwrap().unwrap(), batch);
        store.ack(&batch.batch_id).unwrap();
        let next = store.take().unwrap().unwrap();
        assert_eq!(next.device_id, batch.device_id);
        assert_ne!(next.batch_id, batch.batch_id);
        assert_eq!(next.items[0].execution_count, 1);
        assert_eq!(
            store
                .connection
                .query_row("SELECT COUNT(*) FROM usage_events", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            3
        );
        drop(store);
        let _ = std::fs::remove_file(path);
    }
    #[test]
    fn repeated_triggers_debounce_per_input_without_blocking_other_keys() {
        let mut last = HashMap::new();
        let now = Instant::now();
        assert!(accept_trigger(&mut last, "one", now));
        assert!(!accept_trigger(
            &mut last,
            "one",
            now + Duration::from_millis(100)
        ));
        assert!(accept_trigger(
            &mut last,
            "two",
            now + Duration::from_millis(100)
        ));
        assert!(accept_trigger(&mut last, "one", now + DEBOUNCE));
    }
    #[test]
    fn local_events_without_cloud_sources_remain_local_and_batches_are_bounded() {
        let mut store = Store::open(Path::new(":memory:")).unwrap();
        store.record(event("trigger", &[])).unwrap();
        assert!(store.take().unwrap().is_none());
        let ids = (0..120)
            .map(|value| format!("item-{value:03}"))
            .collect::<Vec<_>>();
        store
            .record(event(
                "addition",
                &ids.iter().map(String::as_str).collect::<Vec<_>>(),
            ))
            .unwrap();
        let first = store.take().unwrap().unwrap();
        assert_eq!(first.items.len(), 100);
        store.ack(&first.batch_id).unwrap();
        let second = store.take().unwrap().unwrap();
        assert_eq!(second.items.len(), 20);
        assert!(second.items.iter().all(|item| !first
            .items
            .iter()
            .any(|prior| prior.item_id == item.item_id)));
        store.ack(&second.batch_id).unwrap();
        assert!(store.take().unwrap().is_none());
    }
    #[test]
    fn interrupted_voice_sessions_do_not_invent_a_completion_duration() {
        let path = std::env::temp_dir().join(format!("axonkey-voice-{}.sqlite3", Uuid::new_v4()));
        let mut store = Store::open(&path).unwrap();
        store
            .record(Message::VoiceStart {
                key: "voice".into(),
                mode: "hold".into(),
                at_ms: 1000,
                at: Instant::now(),
            })
            .unwrap();
        drop(store);
        let store = Store::open(&path).unwrap();
        let session = store
            .connection
            .query_row("SELECT status,duration_ms FROM voice_sessions", [], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, Option<i64>>(1)?))
            })
            .unwrap();
        assert_eq!(session, ("interrupted".into(), None));
        drop(store);
        let _ = std::fs::remove_file(path);
    }
    #[test]
    fn voice_sessions_keep_single_monotonic_duration_in_both_modes() {
        for mode in ["hold", "click"] {
            let mut store = Store::open(Path::new(":memory:")).unwrap();
            let now = Instant::now();
            store
                .record(Message::VoiceStart {
                    key: "voice".into(),
                    mode: mode.into(),
                    at_ms: 1000,
                    at: now,
                })
                .unwrap();
            store
                .record(Message::VoiceStart {
                    key: "voice".into(),
                    mode: mode.into(),
                    at_ms: 1001,
                    at: now,
                })
                .unwrap();
            store
                .record(Message::VoiceStop {
                    key: "voice".into(),
                    at_ms: 3500,
                    at: now + Duration::from_millis(2500),
                })
                .unwrap();
            let session = store
                .connection
                .query_row(
                    "SELECT mode,duration_ms,status FROM voice_sessions",
                    [],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, i64>(1)?,
                            row.get::<_, String>(2)?,
                        ))
                    },
                )
                .unwrap();
            assert_eq!(session, (mode.into(), 2500, "completed".into()));
            assert_eq!(
                store
                    .connection
                    .query_row("SELECT COUNT(*) FROM voice_sessions", [], |row| row
                        .get::<_, i64>(0))
                    .unwrap(),
                1
            );
        }
    }
}

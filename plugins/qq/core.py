"""QQ 文本入口：身份筛选、持久队列和有界回复投递。"""
import asyncio
import hashlib
import json
import ipaddress
import sqlite3
import time
from pathlib import Path
from urllib.parse import urlsplit

import httpx


def stable_id(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True).encode()).hexdigest()


def route_event(event, account, accept_since=0, friend_chat=False):
    """本人命令与好友纯聊天分流；好友不取得账号本人的项目身份。"""
    if str(event.get("self_id")) != account:
        return None
    if event.get("post_type") not in ("message", "message_sent") or event.get("message_type") != "private":
        return None
    if accept_since and (not isinstance(event.get("time"), int) or event["time"] < accept_since):
        return None
    segments = event.get("message")
    if not isinstance(segments, list) or any(item.get("type") != "text" for item in segments):
        return None
    text = "".join(str(item.get("data", {}).get("text", "")) for item in segments).strip()
    sender = str(event.get("user_id"))
    if sender != account:
        if friend_chat is not True or event.get("post_type") != "message" or event.get("sub_type") != "friend" or not text:
            return None
        if not sender.isdigit() or int(sender) < 10000 or type(event.get("message_id")) is not int:
            return None
        return {"id": stable_id([account, sender, event["message_id"]]), "text": text,
                "scene": {"kind": "private", "peerId": sender}, "mode": "chat"}
    if text != "/co" and not text.startswith("/co ") and not text.startswith("/co\n"):
        return None
    # NapCat 的 message_sent 包含真正的 target_id；缺失时不能猜接收者。
    peer = event.get("target_id") if event.get("post_type") == "message_sent" else event.get("user_id")
    if not str(peer).isdigit() or int(peer) < 10000 or type(event.get("message_id")) is not int:
        return None
    return {"id": stable_id([account, event["message_id"]]), "text": text[3:].strip() or "你好",
            "scene": {"kind": "private", "peerId": str(peer)}}


def reply_parts(text, size=1600):
    """拆分是传输分段，不截断或拒绝模型的长答案。"""
    result = []
    while text:
        end = min(len(text), size)
        if len(text) > size:
            split = text.rfind("\n", 0, size)
            if split > size // 2:
                end = split + 1
        result.append("Coordinator：\n" + text[:end])
        text = text[end:]
    return result


class Spool:
    def __init__(self, file):
        Path(file).parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(file)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=FULL")
        self.db.executescript("""
            CREATE TABLE IF NOT EXISTS requests (
                id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, body TEXT NOT NULL,
                scene TEXT NOT NULL, status TEXT NOT NULL, received REAL NOT NULL, error TEXT);
            CREATE TABLE IF NOT EXISTS outbox (
                request_id TEXT NOT NULL, part INTEGER NOT NULL, text TEXT NOT NULL,
                status TEXT NOT NULL, message_id TEXT,
                PRIMARY KEY(request_id, part));
        """)

    def put(self, body):
        encoded = json.dumps(body, ensure_ascii=False, sort_keys=True)
        fingerprint = stable_id(body)
        previous = self.db.execute("SELECT fingerprint FROM requests WHERE id=?", (body["id"],)).fetchone()
        if previous:
            if previous["fingerprint"] != fingerprint:
                raise ValueError("ID_REUSED")
            return False
        with self.db:
            self.db.execute("INSERT INTO requests VALUES(?,?,?,?,?,?,NULL)",
                            (body["id"], fingerprint, encoded, stable_id(body["scene"]), "pending", time.time()))
        return True

    def pending(self):
        # 同一场景的未确认投递会阻止该场景后续消息，不挡其他场景。
        return self.db.execute("""SELECT r.* FROM requests r
            WHERE r.status NOT IN ('done','failed','delivery-unknown') AND NOT EXISTS (
              SELECT 1 FROM requests prior WHERE prior.scene=r.scene AND prior.rowid<r.rowid
              AND prior.status NOT IN ('done','failed')) ORDER BY r.rowid LIMIT 32""").fetchall()

    def set_status(self, request_id, status, error=None):
        with self.db:
            if status == "delivery-unknown":
                self.db.execute("UPDATE requests SET status=?,error=COALESCE(error,?) WHERE id=?", (status, error, request_id))
            else:
                self.db.execute("UPDATE requests SET status=?,error=? WHERE id=?", (status, error, request_id))

    def prepare_reply(self, request_id, texts, failed=False):
        parts = [part for text in texts for part in reply_parts(text)]
        with self.db:
            for index, text in enumerate(parts):
                self.db.execute("INSERT OR IGNORE INTO outbox VALUES(?,?,?,'pending',NULL)", (request_id, index, text))
                prior = self.db.execute("SELECT text FROM outbox WHERE request_id=? AND part=?", (request_id, index)).fetchone()
                if prior["text"] != text:
                    raise ValueError("REPLY_CHANGED")
            self.db.execute("UPDATE requests SET status=?,error=? WHERE id=?", ("reply", "MODEL_FAILED" if failed else None, request_id))

    def parts(self, request_id):
        return self.db.execute("SELECT * FROM outbox WHERE request_id=? ORDER BY part", (request_id,)).fetchall()

    def mark_part(self, request_id, part, status, message_id=None):
        with self.db:
            self.db.execute("UPDATE outbox SET status=?,message_id=? WHERE request_id=? AND part=?", (status, message_id, request_id, part))

    def counts(self):
        return dict(self.db.execute("SELECT status,COUNT(*) FROM requests GROUP BY status"))


class Backend:
    def __init__(self, origin, token):
        parsed = urlsplit(origin)
        if parsed.scheme not in ("https", "http") or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in ("", "/"):
            raise ValueError("Invalid backend URL")
        if parsed.scheme == "http" and parsed.hostname != "localhost":
            try:
                loopback = ipaddress.ip_address(parsed.hostname).is_loopback
            except ValueError:
                loopback = False
            if not loopback:
                raise ValueError("Plaintext backend must be loopback")
        self.client = httpx.AsyncClient(base_url=origin.rstrip("/"), headers={"Authorization": "Bearer " + token},
                                        timeout=httpx.Timeout(20, connect=5), follow_redirects=False, trust_env=False)

    async def request(self, route, body):
        guest = body.get("mode") == "chat"
        payload = {key: value for key, value in body.items() if key != "mode"}
        response = await self.client.post("/api/integrations/qq/" + ("chat/" if guest else "") + route, json=payload)
        response.raise_for_status()
        data = response.json()
        if not isinstance(data, dict):
            raise ValueError("INVALID_BACKEND_REPLY")
        return data


class Worker:
    def __init__(self, spool, backend, bot, account, notify=lambda code: None):
        self.spool, self.backend, self.bot, self.account, self.notify = spool, backend, bot, account, notify
        self.stopping = False
        self.wakeup = asyncio.Event()
        self.slots = asyncio.Semaphore(4)
        self.backoff = {}

    async def process(self, row):
        async with self.slots:
            try:
                await self._process(row)
                self.backoff.pop(row["id"], None)
            except Exception as error:
                # 不打印消息、凭据、私有地图或 SDK 异常正文。
                self.notify(type(error).__name__)
                attempts = min(self.backoff.get(row["id"], (0, 0))[0] + 1, 5)
                self.backoff[row["id"]] = (attempts, time.monotonic() + 2 ** attempts)

    async def _process(self, row):
        body = json.loads(row["body"])
        request_id = row["id"]
        if body.get("mode") == "chat" and row["status"] == "pending":
            if not self.bot():
                return
            friends = await self.bot().call_api("get_friend_list")
            if not isinstance(friends, list):
                raise ValueError("FRIEND_LIST_UNAVAILABLE")
            if not any(str(friend.get("user_id")) == body["scene"]["peerId"] for friend in friends):
                self.spool.set_status(request_id, "failed", "NOT_A_FRIEND")
                return
        if len(body["text"]) > 8000 and row["status"] == "pending":
            self.spool.prepare_reply(request_id, ["这条输入超过接口的8000字限制，原文已保留，请分段发送。"], failed=True)
            row = {**dict(row), "status": "reply"}
        if row["status"] in ("pending", "submitted"):
            if row["status"] == "pending":
                self.spool.set_status(request_id, "submitted")
                result = await self.backend.request("submit", body)
            else:
                try:
                    result = await self.backend.request("state", {key: value for key, value in body.items() if key != "text"})
                except httpx.HTTPStatusError as error:
                    if error.response.status_code not in (404, 409):
                        raise
                    result = await self.backend.request("submit", body)
                if not result.get("accepted"):
                    result = await self.backend.request("submit", body)
            if result.get("error"):
                texts = [item["text"] for item in result.get("replies", [])]
                self.spool.prepare_reply(request_id, texts + ["这次处理出错了，原消息和进度已保留。"], failed=True)
            elif result.get("complete"):
                texts = [item["text"] for item in result.get("replies", [])]
                self.spool.prepare_reply(request_id, texts or ["本轮已结束，但未取得文本回复；原记录已保留。"])
            else:
                return
        if not self.bot():
            return
        for part in self.spool.parts(request_id):
            if part["status"] == "sent":
                continue
            if part["status"] == "unknown":
                self.spool.set_status(request_id, "delivery-unknown", "SEND_RESULT_UNKNOWN")
                return
            # 先保存结果未知。进程在 API 调用前后崩溃时，不能盲目重复发消息。
            self.spool.mark_part(request_id, part["part"], "unknown")
            try:
                recipient = body["scene"]["peerId"] if body.get("mode") == "chat" else self.account
                result = await self.bot().call_api("send_private_msg", user_id=int(recipient),
                                                    message=[{"type": "text", "data": {"text": part["text"]}}])
                if not isinstance(result, dict) or not isinstance(result.get("message_id"), int):
                    raise ValueError("SEND_RESULT_UNKNOWN")
                self.spool.mark_part(request_id, part["part"], "sent", str(result["message_id"]))
            except Exception:
                self.spool.set_status(request_id, "delivery-unknown", "SEND_RESULT_UNKNOWN")
                self.notify("SEND_RESULT_UNKNOWN")
                return
        final = self.spool.db.execute("SELECT error FROM requests WHERE id=?", (request_id,)).fetchone()
        self.spool.set_status(request_id, "failed" if final["error"] == "MODEL_FAILED" else "done", final["error"])

    async def run(self):
        while not self.stopping:
            self.wakeup.clear()
            await asyncio.gather(*(self.process(row) for row in self.spool.pending()
                                  if self.backoff.get(row["id"], (0, 0))[1] <= time.monotonic()))
            try:
                await asyncio.wait_for(self.wakeup.wait(), 2)
            except TimeoutError:
                pass

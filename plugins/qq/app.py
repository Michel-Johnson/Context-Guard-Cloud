"""NapCat OneBot v11 反向 WebSocket 接入，业务仍由 Cloud Coordinator 执行。"""
import asyncio
import json
import os
from pathlib import Path
from typing import Literal

import nonebot
from nonebot import on, on_message
from nonebot.adapters.onebot.v11 import Adapter, Bot, MessageEvent, PrivateMessageEvent
from nonebot.log import logger

from core import Backend, Spool, Worker, route_event

settings = json.loads(Path(os.environ["CONTEXT_GUARD_QQ_ADAPTER_CONFIG"]).read_text(encoding="utf8"))
for key in ("accountId", "backendToken", "onebotToken", "cloudOrigin", "defaultProjectId"):
    if not isinstance(settings.get(key), str) or not settings[key]:
        raise ValueError("Incomplete private QQ adapter configuration")
if len(settings["backendToken"]) < 32 or len(settings["onebotToken"]) < 32 or settings["backendToken"] == settings["onebotToken"]:
    raise ValueError("Use separate bounded QQ adapter credentials")
nonebot.init(driver="~fastapi", host=os.environ.get("HOST", "127.0.0.1"), port=int(os.environ.get("PORT", "18080")),
             log_level="WARNING", onebot_access_token=settings["onebotToken"], api_timeout=15)
driver = nonebot.get_driver()


class SentPrivateMessageEvent(PrivateMessageEvent):
    post_type: Literal["message_sent"]
    target_id: int | None = None


Adapter.add_custom_model(SentPrivateMessageEvent)
driver.register_adapter(Adapter)
spool = Spool(os.environ.get("CONTEXT_GUARD_QQ_STATE", "./state/qq.sqlite"))
backend = Backend(settings["cloudOrigin"], settings["backendToken"])


def bot():
    return nonebot.get_bots().get(settings["accountId"])


worker = Worker(spool, backend, bot, settings["accountId"], lambda code: logger.warning("QQ adapter failure: {}", code))
incoming = on_message(priority=5, block=False)
sent = on("message_sent", priority=5, block=False)


@incoming.handle()
@sent.handle()
async def receive(bot: Bot, event: MessageEvent):
    if bot.self_id != settings["accountId"]:
        return
    payload = {"self_id": event.self_id, "user_id": event.user_id, "post_type": event.post_type,
               "message_type": event.message_type, "message_id": event.message_id, "time": event.time,
               "target_id": getattr(event, "target_id", None),
               "message": [{"type": segment.type, "data": segment.data} for segment in event.original_message]}
    body = route_event(payload, settings["accountId"], settings.get("acceptSince", 0))
    if not body:
        return
    body["projectId"] = settings["defaultProjectId"]
    try:
        spool.put(body)
        worker.wakeup.set()
    except ValueError:
        logger.warning("QQ adapter rejected changed message ID")


runner = None


@driver.on_startup
async def start():
    global runner
    runner = asyncio.create_task(worker.run())


@driver.on_shutdown
async def stop():
    worker.stopping = True
    worker.wakeup.set()
    if runner:
        runner.cancel()
        try:
            await runner
        except asyncio.CancelledError:
            pass
    await backend.client.aclose()
    spool.db.close()


@driver.on_bot_connect
async def connected(bot: Bot):
    worker.wakeup.set()


@driver.server_app.get("/health")
async def health():
    return {"connected": bool(bot()), "queue": spool.counts()}


if __name__ == "__main__":
    nonebot.run()

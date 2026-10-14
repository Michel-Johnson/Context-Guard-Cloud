import asyncio
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import AsyncMock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from core import Backend, Spool, Worker, reply_parts, route_event

ACCOUNT = "123456789"


def message(text="/co hello", **fields):
    return {"self_id": int(ACCOUNT), "user_id": int(ACCOUNT), "post_type": "message_sent",
            "message_type": "private", "message_id": 12, "target_id": int(ACCOUNT), "time": 100,
            "message": [{"type": "text", "data": {"text": text}}], **fields}


class RoutingTests(unittest.TestCase):
    def test_backend_rejects_plaintext_remote_and_url_credentials(self):
        for origin in ["http://192.168.1.2", "http://cloud.example", "https://user:password@example.com", "https://example.com?token=bad"]:
            with self.assertRaises(ValueError):
                Backend(origin, "fixture-token")

    def test_only_owner_commands_and_real_peer_are_accepted(self):
        for event in [message("ordinary"), message("Coordinator：\n/co loop"), message(user_id=987654321),
                      message(self_id=987654321), message(message_type="group"), message(target_id=None),
                      message(message_id=True)]:
            self.assertIsNone(route_event(event, ACCOUNT))
        self.assertIsNone(route_event(message(), ACCOUNT, 101))
        routed = route_event(message(), ACCOUNT)
        self.assertEqual(routed["text"], "hello")
        self.assertEqual(routed["scene"]["peerId"], ACCOUNT)

    def test_no_output_length_rejection_or_truncation(self):
        text = ("一段话\n" * 1200) + "结尾"
        parts = reply_parts(text)
        self.assertEqual("".join(part.removeprefix("Coordinator：\n") for part in parts), text)
        self.assertTrue(all(len(part) <= 1613 for part in parts))

    def test_nonebot_parses_message_sent_as_its_real_type(self):
        from nonebot.adapters.onebot.v11 import Adapter, PrivateMessageEvent
        from typing import Literal

        class Sent(PrivateMessageEvent):
            post_type: Literal["message_sent"]
            target_id: int | None = None

        Adapter.add_custom_model(Sent)
        parsed = Adapter.json_to_event({**message(), "raw_message": "/co hello", "sub_type": "friend", "font": 14,
                                       "sender": {"user_id": int(ACCOUNT), "nickname": "test"}})
        self.assertIsInstance(parsed, Sent)
        self.assertEqual(parsed.get_type(), "message_sent")
        self.assertEqual(parsed.target_id, int(ACCOUNT))


class QueueTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.file = str(Path(self.temp.name) / "queue.sqlite")
        self.spool = Spool(self.file)
        self.body = route_event(message(), ACCOUNT)
        self.body["projectId"] = "fixture"

    def tearDown(self):
        self.spool.db.close()
        self.temp.cleanup()

    async def test_duplicate_and_restart_keep_original_request(self):
        self.assertTrue(self.spool.put(self.body))
        self.assertFalse(self.spool.put(self.body))
        with self.assertRaises(ValueError):
            self.spool.put({**self.body, "text": "changed"})
        self.spool.set_status(self.body["id"], "submitted")
        self.spool.db.close()
        self.spool = Spool(self.file)
        backend = AsyncMock()
        backend.request.return_value = {"accepted": True, "complete": True, "replies": [{"text": "结果"}]}
        bot = AsyncMock()
        bot.call_api.return_value = {"message_id": 18}
        worker = Worker(self.spool, backend, lambda: bot, ACCOUNT)
        await worker.process(self.spool.pending()[0])
        self.assertEqual(backend.request.call_args.args[0], "state")
        self.assertEqual(self.spool.counts(), {"done": 1})
        self.assertEqual(bot.call_api.call_count, 1)
        self.assertEqual(bot.call_api.call_args.kwargs["user_id"], int(ACCOUNT))

    async def test_disconnect_keeps_reply_and_lost_send_ack_is_not_retried(self):
        self.spool.put(self.body)
        self.spool.prepare_reply(self.body["id"], ["结果"])
        worker = Worker(self.spool, AsyncMock(), lambda: None, ACCOUNT)
        await worker.process(self.spool.pending()[0])
        self.assertEqual(self.spool.parts(self.body["id"])[0]["status"], "pending")
        bot = AsyncMock()
        bot.call_api.side_effect = TimeoutError()
        worker.bot = lambda: bot
        await worker.process(self.spool.pending()[0])
        self.assertEqual(self.spool.pending(), [])
        self.assertEqual(bot.call_api.call_count, 1)
        self.assertEqual(self.spool.counts(), {"delivery-unknown": 1})

    async def test_many_unknown_scenes_do_not_starve_another_scene(self):
        for index in range(35):
            body = {**self.body, "id": str(index), "scene": {"kind": "private", "peerId": str(100000 + index)}}
            self.spool.put(body)
            self.spool.set_status(body["id"], "delivery-unknown", "SEND_RESULT_UNKNOWN")
        self.spool.put(self.body)
        self.assertEqual([row["id"] for row in self.spool.pending()], [self.body["id"]])

    async def test_unknown_submission_reuses_stable_id_and_blocks_only_its_scene(self):
        self.spool.put(self.body)
        second = {**self.body, "id": "second"}
        other = {**self.body, "id": "other", "scene": {"kind": "private", "peerId": "987654321"}}
        self.spool.put(second)
        self.spool.put(other)
        self.assertEqual(len(self.spool.pending()), 2)
        self.spool.set_status(self.body["id"], "submitted")
        backend = AsyncMock()
        backend.request.side_effect = [{"accepted": False}, {"accepted": True, "complete": False}]
        worker = Worker(self.spool, backend, lambda: None, ACCOUNT)
        await worker.process(self.spool.pending()[0])
        self.assertEqual([call.args[0] for call in backend.request.call_args_list], ["state", "submit"])
        self.assertEqual(backend.request.call_args.args[1]["id"], self.body["id"])


if __name__ == "__main__":
    unittest.main()

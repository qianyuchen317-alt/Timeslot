"""上游模型调用：任意 OpenAI 兼容接口（本机 vllm-metal 或外部 API）。

以异步生成器逐块产出统一事件：
    {"delta": "正文增量"}
    {"reasoning": "思考增量"}
"""
from __future__ import annotations

import json

import httpx

_TIMEOUT = httpx.Timeout(connect=10.0, read=600.0, write=30.0, pool=10.0)


async def stream_completion(
    base_url: str,
    api_key: str,
    model: str,
    messages: list[dict],
    extra: dict | None = None,
):
    url = base_url.rstrip("/") + "/chat/completions"
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    payload: dict = {
        "model": model,
        "messages": messages,
        "stream": True,
        "temperature": 0.7,
    }
    if extra:
        payload.update(extra)

    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        async with client.stream("POST", url, headers=headers, json=payload) as resp:
            if resp.status_code >= 400:
                body = (await resp.aread()).decode("utf-8", "ignore")
                raise UpstreamError(resp.status_code, body)
            async for line in resp.aiter_lines():
                if not line or not line.startswith("data:"):
                    continue
                data = line[5:].strip()
                if data == "[DONE]":
                    break
                try:
                    obj = json.loads(data)
                except Exception:
                    continue
                choices = obj.get("choices") or [{}]
                delta = choices[0].get("delta") or {}
                reasoning = delta.get("reasoning_content") or delta.get("reasoning")
                if reasoning:
                    yield {"reasoning": reasoning}
                content = delta.get("content")
                if content:
                    yield {"delta": content}


class UpstreamError(RuntimeError):
    def __init__(self, status: int, body: str):
        self.status = status
        self.body = body
        super().__init__(f"upstream {status}: {body[:300]}")

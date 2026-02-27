"""Shared image upload helpers for external providers.

Uploads PIL images to provider CDNs via direct httpx POST calls,
avoiding the need for provider-specific client libraries.
"""

import io
from typing import Optional

import httpx
from PIL import Image


async def upload_image_to_fal(image: Image.Image, api_key: str, timeout: float = 60.0) -> str:
    """Upload a PIL image to FAL CDN and return the hosted URL.

    Uses the FAL file upload API directly via httpx — no fal-client dependency.

    Args:
        image: PIL Image to upload.
        api_key: FAL API key.
        timeout: HTTP timeout in seconds.

    Returns:
        CDN URL string (e.g. "https://fal.media/files/...").
    """
    buf = io.BytesIO()
    image.save(buf, format="PNG")
    image_bytes = buf.getvalue()

    async with httpx.AsyncClient(timeout=timeout) as client:
        resp = await client.post(
            "https://fal.media/files/upload",
            headers={"Authorization": f"Key {api_key}"},
            files={"file": ("image.png", image_bytes, "image/png")},
        )
        resp.raise_for_status()
        return resp.json()["url"]


async def upload_image_to_replicate(image: Image.Image, api_key: str, timeout: float = 60.0) -> str:
    """Upload a PIL image to Replicate files API and return the hosted URL.

    Uses the Replicate files API directly via httpx — no replicate client dependency.

    Args:
        image: PIL Image to upload.
        api_key: Replicate API token.
        timeout: HTTP timeout in seconds.

    Returns:
        Hosted URL string from Replicate's file hosting.
    """
    buf = io.BytesIO()
    image.save(buf, format="PNG")
    image_bytes = buf.getvalue()

    async with httpx.AsyncClient(timeout=timeout) as client:
        resp = await client.post(
            "https://api.replicate.com/v1/files",
            headers={"Authorization": f"Bearer {api_key}"},
            files={"content": ("image.png", image_bytes, "image/png")},
        )
        resp.raise_for_status()
        return resp.json()["urls"]["get"]


async def upload_dynamic_images(
    dynamic_images: dict[str, list[Image.Image]],
    provider: str,
    api_key: str,
    progress_cb: Optional[callable] = None,
) -> dict[str, list[str]]:
    """Upload all dynamic image params and return a dict of field_name → URL list.

    Args:
        dynamic_images: Dict of field_name → list of PIL images.
        provider: Provider identifier ("fal" or "replicate").
        api_key: API key for the provider.
        progress_cb: Optional progress callback.

    Returns:
        Dict mapping field names to URL(s) suitable for the provider API.
    """
    if not dynamic_images:
        return {}

    upload_fn = upload_image_to_fal if provider == "fal" else upload_image_to_replicate
    result: dict[str, list[str]] = {}

    for field_name, images in dynamic_images.items():
        urls: list[str] = []
        for img in images:
            url = await upload_fn(img, api_key)
            urls.append(url)
        result[field_name] = urls

    return result

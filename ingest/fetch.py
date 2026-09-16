"""Fetch the FAA NAS status feed."""
import httpx

FEED_URL = "https://nasstatus.faa.gov/api/airport-status-information"
USER_AGENT = "faa-delay-intel/1.0 (portfolio data pipeline)"
TIMEOUT = 30.0


def fetch_nas_status(url=FEED_URL, attempts=3, client=None):
    """Return the raw XML text of the feed.

    Retries on transient network/5xx errors with linear backoff. Raises the
    last exception if every attempt fails so the caller records an error run.
    """
    last_error = None
    owns_client = client is None
    client = client or httpx.Client(timeout=TIMEOUT, follow_redirects=True)
    try:
        for attempt in range(attempts):
            try:
                response = client.get(
                    url,
                    headers={"User-Agent": USER_AGENT, "Accept": "application/xml"},
                )
                response.raise_for_status()
                if not response.text.strip():
                    raise ValueError("FAA feed returned an empty body")
                return response.text
            except Exception as exc:  # noqa: BLE001 - retried below
                last_error = exc
                if attempt < attempts - 1:
                    import time
                    time.sleep(2 * (attempt + 1))
        raise last_error
    finally:
        if owns_client:
            client.close()

"""Shared message utilities — reusable helpers for message analysis.

Functions shared across services that analyze message history data.
"""

_DEFAULT_RESPONSE_RATE = 40


def compute_response_rate(messages: list[dict], default: float = _DEFAULT_RESPONSE_RATE) -> float:
    """Compute response rate from message history.

    Counts outbound -> inbound response pairs vs total outbound messages.

    Args:
        messages: List of message dicts with 'type' and 'timestamp' keys.
        default: Value returned when messages are empty or no outbound exists.

    Returns:
        Response rate as a percentage (0-100).
    """
    if not messages:
        return default

    valid = [m for m in messages if isinstance(m, dict) and m.get('timestamp')]
    # NOTE: ISO 8601 string sort assumes uniform 'YYYY-MM-DDTHH:MM:SSZ' format
    valid.sort(key=lambda m: m['timestamp'])

    outbound_count = sum(1 for m in valid if m.get('type') == 'outbound')
    if outbound_count == 0:
        return default

    response_pairs = 0
    for i in range(len(valid) - 1):
        if valid[i].get('type') == 'outbound' and valid[i + 1].get('type') == 'inbound':
            response_pairs += 1

    return (response_pairs / outbound_count) * 100

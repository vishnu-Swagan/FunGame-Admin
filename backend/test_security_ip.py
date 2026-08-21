"""Client-address extraction must not trust spoofable forwarded chains."""
from types import SimpleNamespace

from security import _client_ip


def _request(headers=None, peer='10.0.0.5'):
    return SimpleNamespace(
        headers=headers or {},
        client=SimpleNamespace(host=peer) if peer is not None else None,
    )


def test_spoofed_proxy_headers_never_override_authenticated_peer():
    request = _request({
        'cf-connecting-ip': '203.0.113.44',
        'x-forwarded-for': '198.51.100.9, 203.0.113.44',
    })
    assert _client_ip(request) == '10.0.0.5'


def test_untrusted_forwarded_chain_is_ignored_without_cloudflare_header():
    request = _request({'x-forwarded-for': '198.51.100.9'}, peer='10.0.0.5')
    assert _client_ip(request) == '10.0.0.5'


def test_invalid_proxy_headers_do_not_affect_ipv6_peer():
    request = _request({'cf-connecting-ip': 'spoofed, 198.51.100.9'}, peer='2001:db8::8')
    assert _client_ip(request) == '2001:db8::8'


def test_missing_valid_address_is_stable_unknown_bucket():
    assert _client_ip(_request({'x-forwarded-for': '198.51.100.9'}, peer=None)) == 'unknown'

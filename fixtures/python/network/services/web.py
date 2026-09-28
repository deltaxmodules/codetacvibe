import json
import os
import urllib.parse
import urllib.request

import aiohttp
import requests

API_URL = os.environ.get('EXTERNAL_API_URL', 'http://127.0.0.1:9')
API_TOKEN = os.environ.get('EXTERNAL_API_TOKEN', '')
ACCOUNT = os.environ.get('EXTERNAL_ACCOUNT', '')


def headers():
    return {'Authorization': f'Bearer {API_TOKEN}'}


def with_requests():
    response = requests.get(f'{API_URL}/status', params={'account': ACCOUNT}, headers=headers(), timeout=5)
    response.raise_for_status()
    return summarise(response.json())


def with_urllib():
    query = urllib.parse.urlencode({'account': ACCOUNT})
    with urllib.request.urlopen(urllib.request.Request(f'{API_URL}/status?{query}', headers=headers()), timeout=5) as response:
        return summarise(json.load(response))


async def with_aiohttp():
    async with aiohttp.ClientSession(headers=headers()) as session:
        async with session.get(f'{API_URL}/status', params={'account': ACCOUNT}) as response:
            return summarise(await response.json())


def summarise(data):
    return {'ok': data['ok']}

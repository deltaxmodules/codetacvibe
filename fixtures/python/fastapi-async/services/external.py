import os

import httpx

API_URL = os.environ.get('EXTERNAL_API_URL', 'http://127.0.0.1:9')
API_TOKEN = os.environ.get('EXTERNAL_API_TOKEN', '')


async def fetch_forecast(city):
    async with httpx.AsyncClient(base_url=API_URL, timeout=5, headers={'Authorization': f'Bearer {API_TOKEN}'}) as client:
        response = await client.get('/forecast', params={'city': city})
        response.raise_for_status()
        return parse_forecast(response.json())


def parse_forecast(data):
    return {'city': data['city'], 'max': round(data['max'])}

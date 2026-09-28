import os

import boto3
import requests
from botocore.config import Config

BUCKET = 'faturas'


def client():
    return boto3.client('s3', endpoint_url=os.environ.get('S3_ENDPOINT', 'http://127.0.0.1:9'), region_name='eu-west-1',
                        config=Config(s3={'addressing_style': 'path'}, retries={'max_attempts': 1}))


def key_for(name):
    return f'2026/{name}'


def upload(name, content):
    client().put_object(Bucket=BUCKET, Key=key_for(name), Body=content.encode())
    return {'key': key_for(name)}


def share(name):
    url = client().generate_presigned_url('get_object', Params={'Bucket': BUCKET, 'Key': key_for(name)}, ExpiresIn=60)
    response = requests.get(url, timeout=5)
    return {'status': response.status_code, 'bytes': len(response.content)}

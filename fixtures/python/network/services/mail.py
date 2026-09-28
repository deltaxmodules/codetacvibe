import os
import smtplib
from email.message import EmailMessage


def subject_for(total):
    return f'Recibo de {total:.2f} EUR'


def send_receipt(to, total):
    message = EmailMessage()
    message['From'] = 'loja@exemplo.pt'
    message['To'] = to
    message['Subject'] = subject_for(total)
    message.set_content(f'Obrigado. Total: {total:.2f} EUR')
    with smtplib.SMTP(os.environ.get('SMTP_HOST', '127.0.0.1'), int(os.environ.get('SMTP_PORT', '25')), timeout=5) as client:
        refused = client.send_message(message)
    return {'refused': len(refused)}

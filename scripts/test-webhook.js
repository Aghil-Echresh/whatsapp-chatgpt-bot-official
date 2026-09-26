import 'dotenv/config';
import fetch from 'node:fetch';

const webhookUrl = process.argv[2] || 'http://localhost:3000/webhook';
const phoneNumber = process.argv[3] || '989123456789';
const messageText = process.argv[4] || 'Hello, this is a test message!';

if (!webhookUrl) {
  console.error('Usage: node test-webhook.js <webhook-url> [phone] [message]');
  process.exit(1);
}

const simulatedWebhook = {
  object: 'whatsapp_business_account',
  entry: [
    {
      id: 'test-entry',
      changes: [
        {
          value: {
            messaging_product: 'whatsapp',
            metadata: {
              display_phone_number: '201234567890',
              phone_number_id: 'test-id',
              business_account_id: 'test-business-id'
            },
            contacts: [
              {
                profile: { name: 'Test User' },
                wa_id: phoneNumber
              }
            ],
            messages: [
              {
                from: phoneNumber,
                id: `test-msg-${Date.now()}`,
                timestamp: Math.floor(Date.now() / 1000).toString(),
                type: 'text',
                text: { body: messageText }
              }
            ]
          }
        }
      ]
    }
  ]
};

async function testWebhook() {
  console.log(`📤 Sending test webhook to ${webhookUrl}`);
  console.log('Payload:', JSON.stringify(simulatedWebhook, null, 2));
  
  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(simulatedWebhook)
    });
    
    console.log(`\n✅ Response Status: ${response.status}`);
    console.log('Expected: 200 OK');
    
    if (response.status === 200) {
      console.log('✅ Webhook test passed!');
    } else {
      console.log('⚠️  Unexpected status code');
    }
  } catch (error) {
    console.error('❌ Error:', error.message);
  }
}

testWebhook();

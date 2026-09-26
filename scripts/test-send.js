import 'dotenv/config';
import fetch from 'node:fetch';

const phoneNumberId = process.env.PHONE_NUMBER_ID;
const whatsappToken = process.env.WHATSAPP_TOKEN;
const testPhone = process.argv[2] || '989123456789'; // Phone number without +

if (!phoneNumberId || !whatsappToken) {
  console.error('Missing PHONE_NUMBER_ID or WHATSAPP_TOKEN');
  process.exit(1);
}

async function testSendMessage() {
  console.log(`📨 Testing message send to ${testPhone}...`);
  
  try {
    const response = await fetch(
      `https://graph.facebook.com/v23.0/${phoneNumberId}/messages`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${whatsappToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: testPhone,
          type: 'text',
          text: { body: '✅ Test message from WhatsApp ChatGPT Bot!' }
        })
      }
    );
    
    const data = await response.json();
    
    if (response.ok) {
      console.log('✅ Message sent successfully!');
      console.log('Message ID:', data.messages[0].id);
    } else {
      console.error('❌ Failed to send message');
      console.error('Error:', data.error);
    }
  } catch (error) {
    console.error('❌ Error:', error.message);
  }
}

testSendMessage();

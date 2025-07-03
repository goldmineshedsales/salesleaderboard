// netlify/functions/syncReps.js
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const HUBSPOT_PRIVATE_APP_TOKEN = process.env.HUBSPOT_PRIVATE_APP_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

exports.handler = async () => {
  console.info('👥 Starting reps sync...');

  if (!HUBSPOT_PRIVATE_APP_TOKEN || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('❌ Missing environment variables');
    return { statusCode: 500, body: 'Missing environment variables' };
  }

  try {
    const response = await axios.get('https://api.hubapi.com/crm/v3/owners', {
      headers: {
        Authorization: `Bearer ${HUBSPOT_PRIVATE_APP_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });

    const reps = response.data.results.map(rep => {
      const fullName = rep.fullName || '';
      const [first_name, ...rest] = fullName.split(' ');
      return {
        rep_id: rep.id,
        first_name,
        last_name: rest.join(' '),
        full_name: fullName
      };
    });

    const { error } = await supabase.from('reps').upsert(reps, {
      onConflict: ['rep_id']
    });

    if (error) {
      console.error('❌ Error upserting reps:', error);
      return { statusCode: 500, body: JSON.stringify(error) };
    }

    console.info(`✅ Synced ${reps.length} reps.`);
    return { statusCode: 200, body: `Synced ${reps.length} reps.` };
  } catch (err) {
    console.error('❌ Unexpected error:', err);
    return { statusCode: 500, body: err.toString() };
  }
};

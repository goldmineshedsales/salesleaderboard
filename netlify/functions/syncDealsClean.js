const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ✅ helper: write to sync_logs
async function logSync({ type, status, message }) {
  try {
    await supabase.from('sync_logs').insert([
      { type, status, message }
    ]);
  } catch (err) {
    console.error('❌ Failed to log to sync_logs:', err.message);
  }
}

exports.handler = async () => {
  try {
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);
    const isoStart = startOfMonth.toISOString();
    const now = new Date().toISOString();

    const HUBSPOT_HEADERS = {
      Authorization: `Bearer ${process.env.HUBSPOT_PRIVATE_APP_TOKEN}`,
      'Content-Type': 'application/json'
    };

    const response = await axios.post(
      'https://api.hubapi.com/crm/v3/objects/deals/search',
      {
        filterGroups: [
          {
            filters: [
              {
                propertyName: 'createdate',
                operator: 'GTE',
                value: isoStart
              }
            ]
          }
        ],
        properties: ['dealname', 'amount', 'pipeline', 'dealstage', 'closedate'],
        limit: 10
      },
      { headers: HUBSPOT_HEADERS }
    );

    const deals = response.data.results;
    let upserted = 0;

    for (const deal of deals) {
      const { id, properties } = deal;

      const dealRecord = {
        hubspot_id: id,
        dealname: properties.dealname || '',
        amount: parseFloat(properties.amount || 0),
        pipeline: properties.pipeline || '',
        dealstage: properties.dealstage || '',
        closedate: properties.closedate ? new Date(properties.closedate) : null,
        synced_to_hubspot: false,
        last_synced_at: now
      };

      const { error } = await supabase
        .from('deals')
        .upsert(dealRecord, { onConflict: ['hubspot_id'] });

      if (!error) upserted++;
      else console.error(`❌ Upsert error on deal ${id}:`, error.message);
    }

    // ✅ log success
    await logSync({
      type: 'pull',
      status: 'success',
      message: `Synced ${upserted} deals`
    });

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: `✅ Synced ${upserted} deals to Supabase`,
        timestamp: now
      })
    };
  } catch (err) {
    // ❌ log failure
    await logSync({
      type: 'pull',
      status: 'error',
      message: err.message
    });

    return {
      statusCode: 500,
      body: JSON.stringify({ error: `❌ Sync failed: ${err.message}` })
    };
  }
};

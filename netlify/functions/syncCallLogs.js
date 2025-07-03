// netlify/functions/syncCallLogs.js
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const { DateTime } = require('luxon');

const HUBSPOT_PRIVATE_APP_TOKEN = process.env.HUBSPOT_PRIVATE_APP_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

exports.handler = async () => {
  console.info('📞 Starting call log sync...');

  if (!HUBSPOT_PRIVATE_APP_TOKEN || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('❌ Missing environment variables');
    return { statusCode: 500, body: 'Missing environment variables' };
  }

  try {
    const todayISO = DateTime.now().setZone('America/Chicago').toISODate(); // e.g., "2025-07-02"

    const callsResponse = await axios.post(
      'https://api.hubapi.com/crm/v3/objects/calls/search',
      {
        limit: 30,
        sorts: ['-hs_timestamp'],
        properties: ['hs_timestamp', 'direction', 'hs_call_duration', 'hubspot_owner_id']
      },
      {
        headers: {
          Authorization: `Bearer ${HUBSPOT_PRIVATE_APP_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const calls = callsResponse.data.results || [];
    console.info(`📥 Pulled ${calls.length} calls from HubSpot`);

    const allCalls = [];

    for (const call of calls) {
      const props = call.properties || {};
      const rawTimestamp = props.hs_timestamp || props.hs_createdate || call.createdAt;

      if (!rawTimestamp) {
        console.warn(`⚠️ Skipping call with no usable timestamp. ID: ${call.id}`);
        continue;
      }

      const timestamp = DateTime.fromISO(rawTimestamp, { zone: 'utc' }).setZone('America/Chicago');
      const timestampISO = timestamp.toISO();
      const timestampDate = timestamp.toISODate(); // e.g., "2025-07-02"
      const timestampYear = timestamp.year;

      console.log(`🧭 Call ID: ${call.id}`);
      console.log(`   rawTimestamp: ${rawTimestamp}`);
      console.log(`   local ISO:     ${timestampISO}`);
      console.log(`   date only:     ${timestampDate}`);
      console.log(`   today ISO:     ${todayISO}`);

      if (timestampDate !== todayISO) {
        console.info(`⏩ Skipping call not from today. ID: ${call.id}`);
        continue;
      }

      // 🔄 Fetch contact association
      let contactId = null;
      try {
        const assocRes = await axios.get(
          `https://api.hubapi.com/crm/v4/objects/calls/${call.id}/associations/contacts`,
          {
            headers: {
              Authorization: `Bearer ${HUBSPOT_PRIVATE_APP_TOKEN}`,
              'Content-Type': 'application/json'
            }
          }
        );
        contactId = assocRes.data?.results?.[0]?.toObjectId;
      } catch (err) {
        console.warn(`⚠️ Failed to fetch contact association for call ID: ${call.id}`);
      }

      if (!contactId) {
        console.warn(`⚠️ Skipping call without contact ID. Call ID: ${call.id}`);
        continue;
      }

      // 👤 Contact name
      let contactName = null;
      try {
        const contactRes = await axios.get(
          `https://api.hubapi.com/crm/v3/objects/contacts/${contactId}?properties=firstname,lastname`,
          {
            headers: {
              Authorization: `Bearer ${HUBSPOT_PRIVATE_APP_TOKEN}`,
              'Content-Type': 'application/json'
            }
          }
        );
        const cp = contactRes.data.properties;
        contactName = `${cp.firstname || ''} ${cp.lastname || ''}`.trim();
      } catch (err) {
        console.warn(`⚠️ Failed to fetch contact name for ID: ${contactId}`);
      }

      // 👤 Owner name
      let ownerName = null;
      if (props.hubspot_owner_id) {
        try {
          const ownerRes = await axios.get(
            `https://api.hubapi.com/crm/v3/owners/${props.hubspot_owner_id}`,
            {
              headers: {
                Authorization: `Bearer ${HUBSPOT_PRIVATE_APP_TOKEN}`,
                'Content-Type': 'application/json'
              }
            }
          );
          ownerName = ownerRes.data.fullName;
        } catch (err) {
          console.warn(`⚠️ Failed to fetch owner name for ID: ${props.hubspot_owner_id}`);
        }
      }

      allCalls.push({
        call_id: call.id,
        contact_id: contactId,
        owner_id: props.hubspot_owner_id || null,
        duration_seconds: props.hs_call_duration ? parseInt(props.hs_call_duration) : null,
        direction: props.direction || 'UNKNOWN',
        contact_name: contactName || null,
        owner_name: ownerName || null,
        timestamp_iso: timestampISO,
        timestamp_date: timestampDate,
        timestamp_year: timestampYear
      });
    }

    if (allCalls.length === 0) {
      console.info('🚫 No call records to sync.');
      return { statusCode: 200, body: 'No call records to sync.' };
    }

    console.info(`🛠️ Upserting ${allCalls.length} calls into Supabase...`);
    const { error } = await supabase.from('calls').upsert(allCalls, { onConflict: ['call_id'] });

    if (error) {
      console.error('❌ Supabase upsert error:', error);
      return { statusCode: 500, body: JSON.stringify(error) };
    }

    console.info('✅ Sync complete.');
    return { statusCode: 200, body: 'Call sync complete.' };
  } catch (err) {
    console.error('❌ Unexpected error:', err);
    return { statusCode: 500, body: err.toString() };
  }
};

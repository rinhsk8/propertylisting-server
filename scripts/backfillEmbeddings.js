import dotenv from 'dotenv';
import supabase from '../config/supabase.js';

dotenv.config();

async function buildCombinedContentForListing(table, listing) {
  // Fetch related location (if any) by product_uuid = listing.custom_uuid
  let locationText = '';
  if (listing.custom_uuid) {
    const { data: locationRow, error: locationError } = await supabase
      .from('location')
      .select('*')
      .eq('product_uuid', listing.custom_uuid)
      .maybeSingle();

    if (!locationError && locationRow) {
      locationText = Object.values(locationRow)
        .filter(v => typeof v === 'string')
        .join(' ');
    }
  }

  const facilitiesText = Array.isArray(listing.facilities)
    ? listing.facilities.join(' ')
    : (listing.facilities || '');

  const strategicLocationText = Array.isArray(listing.strategic_location)
    ? listing.strategic_location.join(' ')
    : (listing.strategic_location || '');

  const combinedContent = [
    listing.title,
    listing.description,
    listing.zone,
    facilitiesText,
    strategicLocationText,
    locationText,
  ]
    .filter(Boolean)
    .join(' ');

  if (!combinedContent.trim()) {
    // Fallback to JSON of the row so we at least have something
    return JSON.stringify(listing);
  }

  return combinedContent;
}

async function backfillTable(table) {
  console.log(`\nBackfilling embeddings for table "${table}"...`);

  const { data: rows, error } = await supabase
    .from(table)
    .select('*')
    .is('embedding', null);

  if (error) {
    console.error(`Failed to fetch rows from ${table}:`, error.message);
    return;
  }

  if (!rows || rows.length === 0) {
    console.log(`No rows to backfill in ${table} (embedding is already set).`);
    return;
  }

  console.log(`Found ${rows.length} rows in ${table} needing embeddings.`);

  let successCount = 0;
  let failCount = 0;

  for (const row of rows) {
    try {
      const content = await buildCombinedContentForListing(table, row);

      const { error: fnError } = await supabase.functions.invoke('full_embed', {
        body: [
          {
            id: row.id,
            table,
            embeddingColumn: 'embedding',
            content,
          },
        ],
      });

      if (fnError) {
        console.error(`  ❌ Failed embedding for ${table} id=${row.id}:`, fnError.message);
        failCount++;
      } else {
        successCount++;
      }
    } catch (err) {
      console.error(`  ❌ Error embedding for ${table} id=${row.id}:`, err.message || err);
      failCount++;
    }
  }

  console.log(
    `Finished ${table}: ${successCount} succeeded, ${failCount} failed (out of ${rows.length}).`
  );
}

async function main() {
  try {
    await backfillTable('apartment');
    await backfillTable('property');
    await backfillTable('land');
  } catch (err) {
    console.error('Backfill failed:', err.message || err);
  } finally {
    // Ensure Node exits
    process.exit(0);
  }
}

main();


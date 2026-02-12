import supabase from '../config/supabase.js';

async function recomputeListingEmbeddingForLocation(locationRow) {
  try {
    const productUuid = locationRow.product_uuid;
    if (!productUuid) return;

    // Try to find the related listing by custom_uuid across apartment, property, and land
    const [
      { data: apartment, error: aptError },
      { data: property, error: propError },
      { data: land, error: landError },
    ] = await Promise.all([
      supabase.from('apartment').select('*').eq('custom_uuid', productUuid).maybeSingle(),
      supabase.from('property').select('*').eq('custom_uuid', productUuid).maybeSingle(),
      supabase.from('land').select('*').eq('custom_uuid', productUuid).maybeSingle(),
    ]);

    let table = null;
    let listing = null;

    if (!aptError && apartment) {
      table = 'apartment';
      listing = apartment;
    } else if (!propError && property) {
      table = 'property';
      listing = property;
    } else if (!landError && land) {
      table = 'land';
      listing = land;
    }

    if (!table || !listing) {
      return;
    }

    const facilitiesText = Array.isArray(listing.facilities)
      ? listing.facilities.join(' ')
      : (listing.facilities || '');

    const strategicLocationText = Array.isArray(listing.strategic_location)
      ? listing.strategic_location.join(' ')
      : (listing.strategic_location || '');

    const locationText = Object.values(locationRow)
      .filter(v => typeof v === 'string')
      .join(' ');

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

    await supabase.functions.invoke('full_embed', {
      body: [
        {
          id: listing.id,
          table,
          embeddingColumn: 'embedding',
          content: combinedContent,
        },
      ],
    });
  } catch (err) {
    console.error('Failed to recompute embedding for location change:', err);
  }
}

export const locationController = {
  // Get all properties
  async getAllLocation(req, res) {
    try {
      const { data, error } = await supabase
        .from('location')
        .select('*');

      if (error) throw error;

      res.status(200).json({
        success: true,
        data: data
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        message: error?.message || 'Unable to fetch locations'
      });
    }
  },

  // Get single apartment
  async getLocation(req, res) {
    try {
      const { id } = req.params;
      const { data, error } = await supabase
        .from('location')
        .select('*')
        .eq('id', id)
        .single();

      if (error) throw error;
      if (!data) {
        return res.status(404).json({
          success: false,
          message: 'Location not found'
        });
      }

      res.status(200).json({
        success: true,
        data: data
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        message: error?.message || 'Unable to fetch location'
      });
    }
  },

  async getLocationByCustomUuid(req, res) {
    try {
      const { custom_uuid } = req.params;
      const { data, error } = await supabase
        .from('location')
        .select('*')
        .eq('product_uuid', custom_uuid)
        .single();

      if (error) throw error;
      if (!data) {
        return res.status(404).json({
          success: false,
          message: 'Location not found'
        });
      }

      res.status(200).json({
        success: true,
        data: data
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        message: error?.message || 'Unable to fetch location'
      });
    }
  },

  // Create location
  async createLocation(req, res) {
    try {
      const { data, error } = await supabase
        .from('location')
        .insert([req.body])
        .select();

      if (error) throw error;

      const created = data[0];

      // Recompute embedding for related listing (if any)
      await recomputeListingEmbeddingForLocation(created);

      res.status(201).json({
        success: true,
        data: created
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        message: error?.message || 'Unable to create location'
      });
    }
  },

  // Update location
  async updateLocation(req, res) {
    try {
      const { id } = req.params;
      const { data, error } = await supabase
        .from('location')
        .update(req.body)
        .eq('id', id)
        .select();

      if (error) throw error;
      if (!data?.length) {
        return res.status(404).json({
          success: false,
          message: 'Location not found'
        });
      }

      const updated = data[0];

      // Recompute embedding for related listing (if any)
      await recomputeListingEmbeddingForLocation(updated);

      res.status(200).json({
        success: true,
        data: updated
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        message: error?.message || 'Unable to update location'
      });
    }
  },

  // Delete apartment
  async deleteLocation(req, res) {
    try {
      const { id } = req.params;
      const { error } = await supabase
        .from('location')
        .delete()
        .eq('id', id);

      if (error) throw error;

      res.status(200).json({
        success: true,
        message: 'Location deleted successfully'
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        message: error?.message || 'Unable to delete location'
      });
    }
  },
}; 
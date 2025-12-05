import supabase from '../config/supabase.js';

export const apartmentController = {
  // Get all properties
  async getAllApartment(req, res) {
    try {
      const { data, error } = await supabase
        .from('apartment')
        .select('*');

      if (error) throw error;

      res.status(200).json({
        success: true,
        data: data
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        message: error?.message || 'Unable to fetch apartments'
      });
    }
  },

  async getNewApartmentCustomUuid(req, res) {
    try {
      // Fetch all custom_uuid values from apartment table
      const { data, error } = await supabase
        .from('apartment')
        .select('custom_uuid');

      if (error) throw error;

      // If there are no records yet, immediately return a new uuid
      if (!data || data.length === 0) {
        const newUuid = 'APT' + String(Math.floor(1000 + Math.random() * 9000));
        return res.status(200).json({
          success: true,
          custom_uuid: newUuid
        });
      }

      // Make a set of all existing custom_uuid values
      const existingUuids = new Set(data.map(row => row.custom_uuid));

      // Function to generate random 4 digit number (zero-padded)
      function generateRandomNumber() {
        return String(Math.floor(1000 + Math.random() * 9000));
      }

      // Continue generating until we find a unique custom_uuid
      let newUuid;
      let attempts = 0;
      do {
        newUuid = 'APT' + generateRandomNumber();
        attempts++;
        // Fallback: Avoid infinite loop if exhausted (shouldn't happen in 4 digits)
        if (attempts > 10000) throw new Error('Unable to generate unique custom_uuid');
      } while (existingUuids.has(newUuid));

      res.status(200).json({
        success: true,
        custom_uuid: newUuid
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        message: error?.message || 'Unable to generate new apartment custom_uuid'
      });
    }
  },

  // Get single apartment
  async getApartment(req, res) {
    try {
      const { id } = req.params;
      const { data, error } = await supabase
        .from('apartment')
        .select('*')
        .eq('id', id)
        .single();

      if (error) throw error;
      if (!data) {
        return res.status(404).json({
          success: false,
          message: 'Apartment not found'
        });
      }

      res.status(200).json({
        success: true,
        data: data
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        message: error?.message || 'Unable to fetch apartment'
      });
    }
  },

  // Create apartment
  async createApartment(req, res) {
    try {
      const { data, error } = await supabase
        .from('apartment')
        .insert([req.body])
        .select();

      if (error) throw error;

      res.status(201).json({
        success: true,
        data: data[0]
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        message: error?.message || 'Unable to create apartment'
      });
    }
  },

  // Update apartment
  async updateApartment(req, res) {
    try {
      const { id } = req.params;
      const { data, error } = await supabase
        .from('apartment')
        .update(req.body)
        .eq('id', id)
        .select();

      if (error) throw error;
      if (!data?.length) {
        return res.status(404).json({
          success: false,
          message: 'Apartment not found'
        });
      }

      res.status(200).json({
        success: true,
        data: data[0]
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        message: error?.message || 'Unable to update apartment'
      });
    }
  },

  // Delete apartment
  async deleteApartment(req, res) {
    try {
      const { id } = req.params;
      const { error } = await supabase
        .from('apartment')
        .delete()
        .eq('id', id);

      if (error) throw error;

      res.status(200).json({
        success: true,
        message: 'Apartment deleted successfully'
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        message: error?.message || 'Unable to delete apartment'
      });
    }
  },

  async uploadImage(req, res) {
    try {
      const { base64Image, fileName } = req.body;

      // Convert base64 to blob
      const base64Response = await fetch(base64Image);
      const blob = await base64Response.blob();

      // Format the filename
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const sanitizedFileName = fileName
        .replace(/[^a-zA-Z0-9-_]/g, '_')
        .toLowerCase();
      const finalFileName = `${sanitizedFileName}-${timestamp}`;

      // Upload to Supabase storage
      const { error: uploadError, data } = await supabase.storage
        .from('apartment-images')
        .upload(finalFileName, blob);

      if (uploadError) {
        throw uploadError;
      }

      // Get public URL
      const { data: { publicUrl } } = supabase.storage
        .from('apartment-images')
        .getPublicUrl(finalFileName);

      res.status(200).json({
        success: true,
        data: {
          url: publicUrl
        }
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        message: error?.message || 'Unable to upload image'
      });
    }
  }
}; 
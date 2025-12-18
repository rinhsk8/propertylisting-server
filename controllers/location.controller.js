import supabase from '../config/supabase.js';

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

  // Create apartment
  async createLocation(req, res) {
    try {
      const { data, error } = await supabase
        .from('location')
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
        message: error?.message || 'Unable to create location'
      });
    }
  },

  // Update apartment
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

      res.status(200).json({
        success: true,
        data: data[0]
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
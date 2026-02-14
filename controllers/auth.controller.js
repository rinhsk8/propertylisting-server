import supabase from '../config/supabase.js';

export const authController = {
  async signUp(req, res) {
    try {
      console.log('Signup request received:', req.body); // Log incoming request

      const { email, password, full_name, phone, address } = req.body;

      // Validate required fields
      if (!email || !password) {
        console.log('Missing required fields');
        return res.status(400).json({
          success: false,
          error: 'Email and password are required'
        });
      }

      console.log('Attempting Supabase auth signup...'); // Log before auth
      const { data: authData, error: authError } = await supabase.auth.signUp({
        email,
        password,
      });

      if (authError) {
        console.error('Supabase auth error:', authError);
        throw authError;
      }

      console.log('Auth successful, creating profile...'); // Log before profile creation

      const userId = authData.user?.id;
      const { data: existingProfile, error: fetchError } = await supabase
        .from('profiles')
        .select('id, status')
        .eq('email', email)
        .maybeSingle();

      if (fetchError) {
        console.error('Profile fetch error:', fetchError);
        throw fetchError;
      }

      if (!existingProfile) {
        // No profile: create new one
        const { data: profileData, error: profileError } = await supabase
          .from('profiles')
          .insert([
            {
              id: userId,
              full_name,
              email,
              phone,
              address
            }
          ])
          .select()
          .single();

        if (profileError) {
          console.error('Profile creation error:', profileError);
          throw profileError;
        }

        console.log('Profile created successfully');
        return res.status(201).json({
          success: true,
          data: {
            user: profileData,
            session: authData.session
          }
        });
      }

      if (existingProfile.status === 'unverified') {
        // Unverified profile: update it with new signup data
        const { data: updatedData, error: updateError } = await supabase
          .from('profiles')
          .update({ full_name, email, phone, address })
          .eq('id', userId)
          .select();

        if (updateError) {
          console.error('Profile update error:', updateError);
          throw updateError;
        }
        if (!updatedData?.length) {
          return res.status(404).json({
            success: false,
            message: 'Profile not found'
          });
        }
        return res.status(200).json({
          success: true,
          data: {
            user: updatedData[0],
            session: authData.session
          }
        });
      }

      // Profile exists and is not unverified → account already exists
      return res.status(409).json({
        success: false,
        error: 'Account already exists'
      });
    } catch (error) {
      const message = error?.message || 'Unable to complete signup';
      console.error('Signup error details:', {
        message,
        stack: error?.stack,
        error
      });
      res.status(500).json({
        success: false,
        error: message
      });
    }
  },

  async signIn(req, res) {
    try {
      const { email, password } = req.body;

      const { data, error } = await supabase.auth.signInWithPassword({
        email,
        password,
      });

      if (error) throw error;

      res.status(200).json({
        success: true,
        data
      });
    } catch (error) {
      res.status(401).json({
        success: false,
        error: error?.message || 'Invalid credentials'
      });
    }
  },

  async requestPasswordReset(req, res) {
    try {
      const { email, redirectTo } = req.body;

      if (!email) {
        return res.status(400).json({
          success: false,
          error: 'Email is required'
        });
      }

      const options = redirectTo ? { redirectTo } : {};
      const { data, error } = await supabase.auth.resetPasswordForEmail(email, options);

      if (error) throw error;

      res.status(200).json({
        success: true,
        message: 'Check your email for the password reset link'
      });
    } catch (error) {
      res.status(400).json({
        success: false,
        error: error?.message || 'Unable to send reset email'
      });
    }
  },

  async updatePassword(req, res) {
    try {
      const { code, access_token, refresh_token, new_password } = req.body;

      if (!new_password) {
        return res.status(400).json({
          success: false,
          error: 'New password is required'
        });
      }

      if (code) {
        // Frontend sent the code from the reset link URL; exchange it for a session
        const { data: sessionData, error: exchangeError } = await supabase.auth.exchangeCodeForSession(code);
        if (exchangeError) throw exchangeError;
      } else if (access_token && refresh_token) {
        // Frontend sent tokens (e.g. from hash fragment)
        const { error: sessionError } = await supabase.auth.setSession({
          access_token,
          refresh_token
        });
        if (sessionError) throw sessionError;
      } else {
        return res.status(400).json({
          success: false,
          error: 'Either code or access_token and refresh_token are required'
        });
      }

      const { error } = await supabase.auth.updateUser({ password: new_password });
      if (error) throw error;

      res.status(200).json({
        success: true,
        message: 'Password updated successfully'
      });
    } catch (error) {
      res.status(400).json({
        success: false,
        error: error?.message || 'Unable to update password'
      });
    }
  },

  async getProfile(req, res) {
    try {
      const { data: { user }, error } = await supabase.auth.getUser();
      
      if (error || !user) throw new Error('Not authenticated');

      const { data, error: profileError } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', user.id)
        .single();

      if (profileError) throw profileError;

      res.status(200).json({
        success: true,
        data
      });
    } catch (error) {
      res.status(401).json({
        success: false,
        error: error?.message || 'Unable to load profile'
      });
    }
  },

  async getWishlist(req, res) {
    try {
      const { data: { user }, error } = await supabase.auth.getUser();
      if (error || !user) throw new Error('Not authenticated');
      const { data, error: profileError } = await supabase
        .from('profiles')
        .select('wishlist')
        .eq('id', user.id)
        .single();

      if (profileError) throw profileError;

      res.status(200).json({
        success: true,
        data
      });
    } catch (error) {
      res.status(400).json({
        success: false,
        error: error?.message || 'Unable to get wishlist'
      });
    }
  },

  async getAllProfiles(req, res) {
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('*');
        
      if (error) throw error;

      res.status(200).json({
        success: true,
        data
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error?.message || 'Unable to get all profiles'
      });
    }
  }, 

  async updateProfile(req, res) {
    try {
      const { id } = req.params;
      const { data, error } = await supabase
        .from('profiles')
        .update(req.body)
        .eq('id', id)
        .select();
      if (error) throw error;
      if (!data?.length) {
        return res.status(404).json({
          success: false,
          message: 'Profile not found'
        });
      }
      res.status(200).json({
        success: true,
        data
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error?.message || 'Unable to update profile'
      });
    }
  },


  async updateWishlist(req, res) {
    try {
      const { wishlist } = req.body;
      const { data: { user }, error } = await supabase.auth.getUser();
      if (error || !user) throw new Error('Not authenticated');
      const { data, error: profileError } = await supabase
        .from('profiles')
        .update({ wishlist })
        .eq('id', user.id)
        .select()
        .single();

      if (profileError) throw profileError;

      res.status(200).json({
        success: true,
        data
      });
    } catch (error) {
      res.status(400).json({
        success: false,
        error: error?.message || 'Unable to update wishlist'
      });
    }
  },

  async sendVerificationEmail(req, res) {
    try {
      const { email } = req.body;
      
      const { error } = await supabase.auth.resend({
        type: 'signup',
        email: email
      });

      if (error) throw error;

      res.status(200).json({
        success: true,
        message: 'OTP code sent to your email'
      });
    } catch (error) {
      res.status(400).json({
        success: false,
        error: error?.message || 'Unable to send verification email'
      });
    }
  },

  async verifyOTP(req, res) {
    try {
      const { email, token } = req.body;
      
      if (!token || !email) throw new Error('Token and email are required');

      const { error } = await supabase.auth.verifyOtp({
        email,
        token,
        type: 'signup'
      });

      if (error) throw error;

      const { error: profileError } = await supabase
        .from('profiles')
        .update({ status: 'verified' })
        .eq('email', email);

      if (profileError) {
        console.error('Profile status update error:', profileError);
        throw profileError;
      }

      res.status(200).json({
        success: true,
        message: 'Email verified successfully'
      });
    } catch (error) {
      res.status(400).json({
        success: false,
        error: error?.message || 'Unable to verify token'
      });
    }
  },

  async checkSession(req, res) {
    try {
      const { data: { session }, error } = await supabase.auth.getSession();

      if (error) throw error;

      if (!session) {
        return res.status(200).json({
          success: false,
          message: 'No active session found'
        });
      }

      // Get user profile data
      const { data: profileData, error: profileError } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', session.user.id)
        .single();

      if (profileError) throw profileError;

      res.status(200).json({
        success: true,
        data: {
          session,
          user: profileData
        }
      });
    } catch (error) {
      res.status(401).json({
        success: false,
        error: error?.message || 'Unable to verify session'
      });
    }
  },

  async signOut(req, res) {
    try {
      const { error } = await supabase.auth.signOut();
      if (error) throw error;
      res.status(200).json({ success: true, message: 'Logged out successfully' });
    } catch (error) {
      res.status(401).json({ success: false, error: error?.message || 'Unable to logout' });
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
        .from('profiles')
        .upload(finalFileName, blob);

      if (uploadError) {
        throw uploadError;
      }

      // Get public URL
      const { data: { publicUrl } } = supabase.storage
        .from('profiles')
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


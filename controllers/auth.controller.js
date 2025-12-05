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
      const { data: profileData, error: profileError } = await supabase
        .from('profiles')
        .insert([
          {
            id: authData.user?.id,
            full_name,
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

      console.log('Profile created successfully'); // Log success
      res.status(201).json({
        success: true,
        data: {
          user: profileData,
          session: authData.session
        }
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
        return res.status(401).json({
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
  }
}; 
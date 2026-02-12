import { Router } from 'express';
import { authController } from '../controllers/auth.controller.js';

const router = Router();

const {signUp, signIn, getProfile, getWishlist, updateWishlist, sendVerificationEmail, verifyOTP, checkSession, signOut} = authController;

router.post('/signup', signUp);
router.post('/signin', signIn);
router.get('/profile', getProfile);
router.get('/get-wishlist', getWishlist);
router.post('/update-wishlist', updateWishlist);
router.post('/send-verification-email', sendVerificationEmail);
router.post('/verify-otp', verifyOTP);
router.post('/signout', signOut);
router.get('/check-session', checkSession);

export default router; 
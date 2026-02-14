import { Router } from 'express';
import { authController } from '../controllers/auth.controller.js';

const router = Router();

const {signUp, signIn, getProfile, getAllProfiles, getWishlist, updateWishlist, updateProfile, sendVerificationEmail, verifyOTP, checkSession, signOut, uploadImage} = authController;

router.post('/signup', signUp);
router.post('/signin', signIn);
router.get('/profile', getProfile);
router.get('/all-profiles', getAllProfiles);
router.get('/get-wishlist', getWishlist);
router.post('/update-wishlist', updateWishlist);
router.put('/update-profile/:id', updateProfile);
router.post('/send-verification-email', sendVerificationEmail);
router.post('/verify-otp', verifyOTP);
router.post('/signout', signOut);
router.get('/check-session', checkSession);
router.post('/upload', uploadImage);

export default router; 
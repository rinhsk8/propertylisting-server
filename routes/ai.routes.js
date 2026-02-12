import { Router } from 'express';
import { aiSearchController } from '../controllers/aiSearch.controller.js';
import { aiChatController } from '../controllers/aiChat.controller.js';

const router = Router();

const { search } = aiSearchController;
const { chat } = aiChatController;

router.post('/', search);
router.post('/chat', chat);

export default router;



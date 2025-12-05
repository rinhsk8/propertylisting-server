import { Router } from 'express';
import { landController } from '../controllers/land.controller.js';

const router = Router();

const { getAllLand, getLand, createLand, updateLand, deleteLand, uploadImage, getNewLandCustomUuid } = landController;

router.get('/', getAllLand);
router.get('/newcustomid', getNewLandCustomUuid);
router.get('/:id', getLand);
router.post('/', createLand);
router.put('/:id', updateLand);
router.delete('/:id', deleteLand);
router.post('/upload', uploadImage);

export default router; 
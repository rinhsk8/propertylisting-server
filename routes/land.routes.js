import { Router } from 'express';
import { landController } from '../controllers/land.controller.js';

const router = Router();

const { getAllLand, getLand, createLand, updateLand, updateLandStatus, deleteLand, uploadImage, getNewLandCustomUuid, getLandByCustomUuid, getAllLandByUserId } = landController;

router.get('/', getAllLand);
router.get('/newcustomid', getNewLandCustomUuid);
router.get('/:id', getLand);
router.get('/customuuid/:custom_uuid', getLandByCustomUuid);
router.get('/user/:user_uuid', getAllLandByUserId);
router.post('/', createLand);
router.put('/:id', updateLand);
router.patch('/status/:custom_uuid', updateLandStatus);
router.delete('/:custom_uuid', deleteLand);
router.post('/upload', uploadImage);

export default router; 
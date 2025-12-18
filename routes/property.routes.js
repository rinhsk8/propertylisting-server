import { Router } from 'express';
import { propertyController } from '../controllers/property.controller.js';

const router = Router();

const { getAllProperties, getNewPropertyCustomUuid, getProperty, createProperty, updateProperty, deleteProperty, uploadImage, getPropertyByCustomUuid, getAllPropertyByUserId } = propertyController;

router.get('/', getAllProperties);
router.get('/newcustomid', getNewPropertyCustomUuid);
router.get('/:id', getProperty);
router.get('/customuuid/:custom_uuid', getPropertyByCustomUuid);
router.get('/user/:user_uuid', getAllPropertyByUserId);
router.post('/', createProperty);
router.put('/:id', updateProperty);
router.delete('/:id', deleteProperty);
router.post('/upload', uploadImage);

export default router; 
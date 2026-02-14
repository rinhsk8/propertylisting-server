import { Router } from 'express';
import { propertyController } from '../controllers/property.controller.js';

const router = Router();

const { getAllProperties, getNewPropertyCustomUuid, getProperty, createProperty, updateProperty, updatePropertyStatus, updatePropertyApprovalStatus, deleteProperty, uploadImage, getPropertyByCustomUuid, getAllPropertyByUserId } = propertyController;

router.get('/', getAllProperties);
router.get('/newcustomid', getNewPropertyCustomUuid);
router.get('/:id', getProperty);
router.get('/customuuid/:custom_uuid', getPropertyByCustomUuid);
router.get('/user/:user_uuid', getAllPropertyByUserId);
router.post('/', createProperty);
router.put('/:id', updateProperty);
router.patch('/status/:custom_uuid', updatePropertyStatus);
router.patch('/approval-status/:custom_uuid', updatePropertyApprovalStatus);
router.delete('/:custom_uuid', deleteProperty);
router.post('/upload', uploadImage);

export default router; 
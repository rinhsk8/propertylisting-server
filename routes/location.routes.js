import { Router } from 'express';
import { locationController } from '../controllers/location.controller.js';

const router = Router();

const { getAllLocation, getLocation, getLocationByCustomUuid, createLocation, updateLocation, deleteLocation } = locationController;

router.get('/', getAllLocation);
router.get('/:id', getLocation);
router.get('/customuuid/:custom_uuid', getLocationByCustomUuid);
router.post('/', createLocation);
router.put('/:id', updateLocation);
router.delete('/:id', deleteLocation);

export default router; 
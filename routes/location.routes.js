import { Router } from 'express';
import { locationController } from '../controllers/location.controller.js';

const router = Router();

const { getAllLocation, getLocation, createLocation, updateLocation, deleteLocation } = locationController;

router.get('/', getAllLocation);
router.get('/:id', getLocation);
router.post('/', createLocation);
router.put('/:id', updateLocation);
router.delete('/:id', deleteLocation);

export default router; 
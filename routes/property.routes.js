import { Router } from 'express';
import { propertyController } from '../controllers/property.controller.js';

const router = Router();

const { getAllProperties, getProperty, createProperty, updateProperty, deleteProperty, uploadImage } = propertyController;

router.get('/', getAllProperties);
router.get('/:id', getProperty);
router.post('/', createProperty);
router.put('/:id', updateProperty);
router.delete('/:id', deleteProperty);
router.post('/upload', uploadImage);

export default router; 
import { Router } from 'express';
import { apartmentController } from '../controllers/apartment.controller.js';

const router = Router();

const { getAllApartment, getApartment, createApartment, updateApartment, updateApartmentStatus, updateApartmentApprovalStatus, deleteApartment, uploadImage, getNewApartmentCustomUuid, getApartmentByCustomUuid, getAllApartmentByUserId} = apartmentController;

router.get('/', getAllApartment);
router.get('/newcustomid', getNewApartmentCustomUuid);
router.get('/:id', getApartment);
router.get('/customuuid/:custom_uuid', getApartmentByCustomUuid);
router.get('/user/:user_uuid', getAllApartmentByUserId);
router.post('/', createApartment);
router.put('/:id', updateApartment);
router.patch('/status/:custom_uuid', updateApartmentStatus);
router.patch('/approval-status/:custom_uuid', updateApartmentApprovalStatus);
router.delete('/:custom_uuid', deleteApartment);
router.post('/upload', uploadImage);

export default router; 